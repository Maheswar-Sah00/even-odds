/**
 * The DEPLOYED api Function's offers area, called exactly as the browser calls
 * it (browser SDK createExecution with a real user session). Requires
 * `npm run functions:deploy`. The program is created already drawn with
 * offers issued (TEST-ONLY setup); its seat is taken through placeGroup().
 */
import { randomUUID } from 'node:crypto';
import { Client as BrowserClient, ExecutionMethod, Functions } from 'appwrite';
import { Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applicationRowId, preferenceRowId } from '../../functions/shared/applications.ts';
import { newPublicId } from '../../functions/shared/crypto.ts';
import type { FunctionResponse } from '../../functions/shared/function-runtime.ts';
import { guardianRowId } from '../../functions/shared/household.ts';
import { ledgerRowId } from '../../functions/shared/organiser.ts';
import { placeGroup } from '../../functions/shared/placement.ts';
import type { TableKey } from '../../shared/config.ts';
import { OFFER_TTL_MS } from '../../shared/offer-lifecycle.ts';
import { createSyntheticUser, db, RUN_ID, serverEnv, syntheticProgram } from './helpers/server.ts';

type U = Awaited<ReturnType<typeof createSyntheticUser>>;
let A: U, B: U;
const programId = `itof-${RUN_ID}`.slice(0, 36);
const familyId = `fof-${RUN_ID}`.slice(0, 36);
const childId = `cof-${RUN_ID}`.slice(0, 36);
let placementId = '';

async function call<T>(client: BrowserClient, body: Record<string, unknown>): Promise<{ status: number; body: FunctionResponse<T> }> {
  const ex = await new Functions(client).createExecution({ functionId: 'api', body: JSON.stringify({ area: 'offers', ...body }), async: false, method: ExecutionMethod.POST, headers: { 'content-type': 'application/json' } });
  return { status: ex.responseStatusCode, body: JSON.parse(ex.responseBody) as FunctionResponse<T> };
}

beforeAll(async () => {
  [A, B] = await Promise.all([createSyntheticUser('offA'), createSyntheticUser('offB')]);
  await db.createRow('programs', programId, syntheticProgram({ status: 'drawn', org_team_id: serverEnv.organiserTeamId ?? 'organisers', offers_issued_at: new Date().toISOString() }));
  await db.createRow('seat_ledger', ledgerRowId(programId, 'W1', 'young'), { program_id: programId, week: 'W1', week_start: '2027-06-14T00:00:00.000Z', age_group: 'young', min_age: 5, max_age: 8, capacity: 1, taken: 0 });
  await db.createRow('guardians', guardianRowId(A.userId), { user_id: A.userId, family_id: familyId, role: 'primary' });
  await db.createRow('applications', applicationRowId(programId, familyId), { program_id: programId, family_id: familyId, public_id: newPublicId(), status: 'submitted', sibling_mode: 'independent', synthetic: true });
  await db.createRow('preferences', preferenceRowId(programId, childId), { program_id: programId, family_id: familyId, child_id: childId, ranked_weeks: ['W1'], requested_weeks: 1, held_weeks: 0 });
  const placed = await placeGroup(db, {
    programId, familyId, week: 'W1', members: [{ childId, ageGroup: 'young' }], idempotencyKey: `fn:${programId}`, permissions: [], offerTtlMs: OFFER_TTL_MS,
    stage: async (transactionId) => { await db.incrementRowColumn('preferences', preferenceRowId(programId, childId), 'held_weeks', { value: 1, max: 1, transactionId }); },
  });
  if (placed.status !== 'placed') throw new Error('setup failed');
  placementId = placed.placementIds[0] ?? '';
});

afterAll(async () => {
  for (const t of ['placements', 'waitlist', 'idempotency', 'preferences', 'applications', 'seat_ledger', 'offer_stats', 'audit_log'] as TableKey[]) {
    await db.deleteRowsWhere(t, [Query.equal('program_id', programId)]).catch(() => undefined);
  }
  await db.deleteRow('guardians', guardianRowId(A.userId)).catch(() => undefined);
  await db.deleteRow('programs', programId).catch(() => undefined);
  await Promise.all([A.remove(), B.remove()]);
}, 300_000);

describe('deployed offers area', () => {
  it('shows a family its own offer with a server-set 48 h expiry', async () => {
    const res = await call<{ serverTime: string; programs: { programId: string; offers: { placementId: string; status: string; expiresAt: string; offeredAt: string }[] }[] }>(A.client, { action: 'mine' });
    expect(res.status).toBe(200);
    if (!res.body.ok) throw new Error(res.body.error.message);
    const offer = res.body.data.programs.find((p) => p.programId === programId)?.offers[0];
    expect(offer).toMatchObject({ placementId, status: 'offered' });
    expect(Date.parse(offer?.expiresAt ?? '') - Date.parse(offer?.offeredAt ?? '')).toBe(OFFER_TTL_MS);
  });

  it('refuses another account, and refuses organiser actions to non-organisers', async () => {
    const other = await call(B.client, { action: 'respond', programId, placementIds: [placementId], response: 'accept', idempotencyKey: randomUUID().replaceAll('-', '') });
    expect(other.status).toBe(404);
    const overview = await call(B.client, { action: 'overview', programId });
    expect(overview.status).toBe(403);
  });

  it('accepts once; a retry with the same key replays the committed result', async () => {
    const idempotencyKey = randomUUID().replaceAll('-', '');
    const body = { action: 'respond', programId, placementIds: [placementId], response: 'accept', idempotencyKey };
    const [first, second] = await Promise.all([call<{ status: string }>(A.client, body), call<{ status: string }>(A.client, body)]);
    const statuses = [first, second].map((r) => (r.body.ok ? r.body.data.status : r.body.error.code)).sort();
    expect(statuses).toEqual(['changed', 'replayed']);
    expect((await db.getRow('placements', placementId)).status).toBe('accepted');
    expect((await db.getRow('seat_ledger', ledgerRowId(programId, 'W1', 'young'))).taken).toBe(1);
  });
});
