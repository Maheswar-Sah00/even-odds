/**
 * Task 10 through the DEPLOYED Appwrite Functions (real runtime, real network
 * from Appwrite Cloud to drand). Run `npm run functions:deploy` first.
 *
 * A synthetic organiser is added to the real organiser Team for the duration
 * of this file and removed afterwards.
 */
import { Functions as BrowserFunctions, ExecutionMethod } from 'appwrite';
import { Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../functions/shared/audit.ts';
import { freezeProgram } from '../../functions/shared/freeze.ts';
import { DRAND_VERIFIER } from '../../shared/freeze/drand.ts';
import { auditOf, cleanupScenarios, PAST_ROUND, scenario } from './helpers/freeze-scenario.ts';
import { aw, createSyntheticUser, db, serverEnv } from './helpers/server.ts';

const teamId = serverEnv.organiserTeamId;
if (!teamId) throw new Error('APPWRITE_ORGANISER_TEAM_ID must be set: the deployed Functions authorise organisers against that Team.');

type U = Awaited<ReturnType<typeof createSyntheticUser>>;
let organiser: U, family: U;
let membershipId = '';

beforeAll(async () => {
  [organiser, family] = await Promise.all([createSyntheticUser('frzOrg'), createSyntheticUser('frzFam')]);
  const m = await aw.teams.createMembership({ teamId, roles: ['organiser'], userId: organiser.userId });
  membershipId = m.$id;
});

afterAll(async () => {
  await aw.teams.deleteMembership({ teamId, membershipId }).catch(() => undefined);
  await Promise.all([organiser.remove(), family.remove()]);
  await cleanupScenarios();
});

const execute = async (user: U, functionId: 'api' | 'jobs', body: Record<string, unknown>) => {
  const ex = await new BrowserFunctions(user.client).createExecution({ functionId, body: JSON.stringify(body), async: false, method: ExecutionMethod.POST });
  return { status: ex.responseStatusCode, body: JSON.parse(ex.responseBody || '{}') as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } };
};

describe('freeze through the deployed api Function', () => {
  it('refuses non-organisers', async () => {
    const { programId } = await scenario('fnauth', { prefix: 'itg', families: 1 });
    const res = await execute(family, 'api', { area: 'organiser', action: 'freeze', programId });
    expect(res.status).toBe(403);
    expect((await db.getRow('programs', programId)).status).toBe('open');
  });

  it('refuses to freeze while applications are still open', async () => {
    const { programId } = await scenario('fnopen', { prefix: 'itg', families: 1 });
    const res = await execute(organiser, 'api', { area: 'organiser', action: 'freeze', programId });
    expect(res.status).toBe(423);
    expect(res.body.error).toMatchObject({ code: 'locked', message: expect.stringMatching(/only be frozen after they close/) as unknown });
  });
});

describe('beacon verification and draw inside the deployed jobs Function', () => {
  it('fetches and verifies the announced drand round from Appwrite Cloud, then draws', async () => {
    const { programId, afterClose } = await scenario('fndraw', { prefix: 'itg', past: true, families: 5 });
    const frozen = await freezeProgram(db, programId, { now: afterClose });

    // First call: the Function resolves the beacon (HTTPS to drand + BLS verification in the runtime) and runs the draw.
    const res = await execute(organiser, 'jobs', { job: 'draw', drawRunId: frozen.drawRunId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: { status: 'completed' } });

    const run = await db.getRow('draw_runs', frozen.drawRunId);
    expect(run).toMatchObject({ status: 'completed', beacon_verified: true, beacon_verifier: DRAND_VERIFIER, drand_round: PAST_ROUND });
    expect((await db.getRow('programs', programId)).status).toBe('drawn');
    const audit = await auditOf(programId);
    expect(verifyChain(audit)).toEqual({ ok: true });
    // Task 13: the committed placements are published for replay; Task 11: then the draw offers (48 h clock) are issued.
    expect(audit.map((e) => e.event)).toEqual(['program_published', 'inputs_frozen', 'beacon_verified', 'draw_completed', 'result_published', 'offers_issued']);
    const published = (await db.listRows('draw_results', [Query.equal('program_id', programId)])).rows[0];
    expect(published).toMatchObject({ draw_run_id: frozen.drawRunId, plan_hash: run.plan_hash, inputs_hash: frozen.inputsHash });

    // Repeating the trigger is safe: nothing is redrawn and no audit entry is added.
    const again = await execute(organiser, 'jobs', { job: 'draw', drawRunId: frozen.drawRunId });
    expect(again.body).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(await auditOf(programId)).toHaveLength(audit.length);
    const placements = await db.listRows('placements', [Query.equal('program_id', programId), Query.limit(500)]);
    expect(placements.total).toBeGreaterThan(0);
  });
});
