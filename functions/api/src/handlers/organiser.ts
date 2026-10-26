import { ID } from 'node-appwrite';
import { organiserRequestSchema, parseSessionsCsv } from '../../../../shared/program-input.ts';
import { AppError } from '../../../shared/app-error.ts';
import { logStaffAction, setCapacityLogged, type ConsoleActor } from '../../../shared/console.ts';
import { createServerDb } from '../../../shared/db.ts';
import { freezeProgram } from '../../../shared/freeze.ts';
import { requireEnv, requireUser, type HandlerInput } from '../../../shared/function-runtime.ts';
import { assertProduction } from '../../../shared/namespace.ts';
import {
  checkPublishable,
  classifyPoint,
  createProgram,
  publishProgram,
  replaceSessions,
  replaceZones,
  requireOrganiser,
  updateProgram,
} from '../../../shared/organiser.ts';

/**
 * Organiser area of the api Function: the only write path for programs,
 * sessions and zones. Every action re-checks organiser Team membership.
 */
export async function handleOrganiser({ userId, body, aw }: HandlerInput): Promise<unknown> {
  const caller = requireUser(userId);
  const teamId = requireEnv('APPWRITE_ORGANISER_TEAM_ID');
  await requireOrganiser(aw.teams, teamId, caller);
  const request = organiserRequestSchema.parse(body);
  const db = createServerDb(aw);
  const ownProgram = async (programId: string) => {
    const program = await db.getRow('programs', programId).catch(() => null);
    if (!program || program.org_team_id !== teamId) throw new AppError('not_found', 'Program not found.');
    assertProduction(program);
    return program;
  };
  const actor = async (programId: string): Promise<ConsoleActor> => ({ program: await ownProgram(programId), actorId: caller, teamId, scope: 'production', users: aw.users });
  switch (request.action) {
    case 'createProgram':
      return createProgram(db, teamId, request.details, { programId: ID.unique() });
    case 'updateProgram':
      return updateProgram(db, teamId, request.programId, request.details);
    case 'importSessions': {
      const parsed = parseSessionsCsv(request.csv);
      if (!request.commit || parsed.errors.length > 0) return { ...parsed, committed: false };
      const result = await replaceSessions(db, teamId, request.programId, parsed.sessions);
      return { ...parsed, committed: true, ...result };
    }
    case 'setCapacity':
      // Privileged: committed together with its staff log entry (console.ts).
      return setCapacityLogged(db, await actor(request.programId), request);
    case 'saveZones':
      return replaceZones(db, teamId, request.programId, request.zones);
    case 'checkPublish':
      return checkPublishable(db, await ownProgram(request.programId));
    case 'publish':
      return publishProgram(db, teamId, request.programId);
    case 'freeze': {
      const who = await actor(request.programId);
      const result = await freezeProgram(db, request.programId);
      if (result.status === 'frozen') await logStaffAction(db, who, { action: 'inputs_frozen', key: `freeze:${request.programId}`, detail: { inputs_hash: result.inputsHash, drand_round: result.drandRound } });
      return result;
    }
    case 'classifyPoint':
      return classifyPoint(db, await ownProgram(request.programId), request.point);
  }
}
