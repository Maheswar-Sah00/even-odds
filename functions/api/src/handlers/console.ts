import { consoleRequestSchema } from '../../../../shared/console-input.ts';
import { AppError } from '../../../shared/app-error.ts';
import { runConsoleCommand } from '../../../shared/console.ts';
import { createServerDb } from '../../../shared/db.ts';
import { requireEnv, requireUser, type HandlerInput } from '../../../shared/function-runtime.ts';
import { assertProduction } from '../../../shared/namespace.ts';
import { requireOrganiser } from '../../../shared/organiser.ts';

/**
 * Console area of the api Function: the organiser control centre for
 * PRODUCTION programs. Re-checks organiser Team membership and program
 * ownership on every call; demo sandboxes are invisible here (they have
 * their own area, handlers/demo.ts).
 */
export async function handleConsole({ userId, body, aw }: HandlerInput): Promise<unknown> {
  const caller = requireUser(userId);
  const teamId = requireEnv('APPWRITE_ORGANISER_TEAM_ID');
  await requireOrganiser(aw.teams, teamId, caller);
  const request = consoleRequestSchema.parse(body);
  const db = createServerDb(aw);
  const program = await db.getRow('programs', request.programId).catch(() => null);
  if (!program || program.org_team_id !== teamId) throw new AppError('not_found', 'Program not found.');
  assertProduction(program);
  return runConsoleCommand(db, { program, actorId: caller, teamId, scope: 'production', users: aw.users }, request.command);
}
