/**
 * Task 12 judge sandbox against REAL Appwrite (TablesDB, Teams, drand):
 * seeding, isolation in both directions, the console's privileged changes
 * and their logs, the duplicate-child and full-seat demonstrations, the
 * fast-forwarded freeze and a live draw, demo offer expiry, and an
 * idempotent reset that never touches anything outside the sandbox.
 * Each claim the demo makes on screen is checked here against the rows.
 */
import { ID, Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../functions/shared/app-error.ts';
import { verifyChain } from '../../functions/shared/audit.ts';
import { runConsoleCommand, type ConsoleActor } from '../../functions/shared/console.ts';
import { assertProduction, assertSandboxOf } from '../../functions/shared/namespace.ts';
import { setCapacity } from '../../functions/shared/organiser.ts';
import {
  closeApplications,
  destroySandbox,
  duplicateChildDemo,
  expireSandboxOffers,
  openSandbox,
  resetSandbox,
  respondAsSynthetic,
  rollbackDemo,
  runSandboxDraw,
  sandboxActor,
  sandboxStatus,
  type SandboxCaller,
} from '../../functions/shared/sandbox.ts';
import { DEMO_FAMILIES, DEMO_OVERSUBSCRIBED, DEMO_SESSIONS } from '../../shared/demo-scenario.ts';
import { publishDrawResult } from '../../functions/shared/draw-result.ts';
import { parseFrozenInputs } from '../../shared/freeze/canonical.ts';
import { parseOutcomes, replayBundle } from '../../shared/replay/index.ts';
import { bundleFromRecord, type PublishedRecord } from '../../src/features/audit/verify.ts';
import { HOLDING_STATUSES, type OfferStatus } from '../../shared/offer-lifecycle.ts';
import { aw, createSyntheticUser, db, serverEnv } from './helpers/server.ts';

type U = Awaited<ReturnType<typeof createSyntheticUser>>;
let visitor: U, stranger: U;
let caller: SandboxCaller;
let programId = '';
const key = () => `it-${ID.unique()}`;
const expectAppError = async (p: Promise<unknown>, code: AppError['code']) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected AppError ${code}`).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
};
const command = async (cmd: Parameters<typeof runConsoleCommand>[2]) => runConsoleCommand(db, await sandboxActor(caller), cmd);

async function assertSeatInvariants(id: string) {
  const [ledgers, placements] = await Promise.all([
    db.listRows('seat_ledger', [Query.equal('program_id', id), Query.limit(100)]),
    db.listRows('placements', [Query.equal('program_id', id), Query.limit(500)]),
  ]);
  const holding = placements.rows.filter((p) => (HOLDING_STATUSES as readonly OfferStatus[]).includes(p.status));
  for (const l of ledgers.rows) {
    expect(l.taken, `${l.week}/${l.age_group}`).toBe(holding.filter((p) => p.ledger_id === l.$id).length);
    expect(l.taken).toBeLessThanOrEqual(l.capacity);
  }
}

beforeAll(async () => {
  [visitor, stranger] = await Promise.all([createSyntheticUser('judge'), createSyntheticUser('stranger')]);
  const secret = serverEnv.childKeySecret;
  if (!secret) throw new Error('CHILD_KEY_SECRET is required for the sandbox tests');
  caller = { aw, db, ownerId: visitor.userId, secret };
});

afterAll(async () => {
  await destroySandbox(aw, db, visitor.userId).catch(() => undefined);
  await destroySandbox(aw, db, stranger.userId).catch(() => undefined);
  await Promise.all([visitor.remove(), stranger.remove()]);
});

describe('judge sandbox', () => {
  it('seeds a private, synthetic, oversubscribed demo program for the visitor', async () => {
    // Two first requests at once (two tabs, or React's double effect in development) converge on one sandbox.
    const [{ sandbox, program }, twin] = await Promise.all([openSandbox(caller), openSandbox(caller)]);
    expect(twin.program.$id).toBe(program.$id);
    programId = program.$id;
    expect((await db.listRows('audit_log', [Query.equal('program_id', programId), Query.equal('event', 'program_published')])).total).toBe(1);
    expect(program).toMatchObject({ namespace: 'demo', sandbox_owner: visitor.userId, synthetic: true, status: 'open' });
    expect(program.drand_round ?? null).toBeNull(); // announced at the fast-forwarded close, not at publish
    const again = await openSandbox(caller);
    expect(again.program.$id).toBe(programId); // idempotent

    const status = await sandboxStatus(caller);
    expect(status.families).toHaveLength(DEMO_FAMILIES.length);
    expect(status.families.every((f) => f.publicId)).toBe(true);
    expect(status.sessions).toHaveLength(DEMO_SESSIONS.length);
    const demand = (await command({ action: 'demand' })) as { sessions: { week: string; ageGroup: string; ranked: number; capacity: number; oversubscribed: boolean }[] };
    const hot = demand.sessions.find((s) => s.week === DEMO_OVERSUBSCRIBED.week && s.ageGroup === DEMO_OVERSUBSCRIBED.ageGroup);
    expect(hot?.oversubscribed).toBe(true);
    expect(hot?.ranked).toBe(14);

    // Real Team-based row permissions: the visitor reads it, nobody else does.
    const members = await aw.teams.listMemberships({ teamId: sandbox.team_id });
    expect(members.memberships.map((m) => m.userId)).toEqual([visitor.userId]);
    await expect(visitor.tablesDB.getRow({ databaseId: serverEnv.databaseId, tableId: 'programs', rowId: programId })).resolves.toMatchObject({ $id: programId });
    await expect(stranger.tablesDB.getRow({ databaseId: serverEnv.databaseId, tableId: 'programs', rowId: programId })).rejects.toMatchObject({ code: 404 });
  });

  it('keeps demo and production apart on the server', async () => {
    const program = await db.getRow('programs', programId);
    expect(() => { assertProduction(program); }).toThrow(AppError);
    expect(() => { assertSandboxOf(program, stranger.userId); }).toThrow(AppError);
    // Production organiser code refuses the sandbox even with the right team ID.
    await expectAppError(setCapacity(db, program.org_team_id, programId, (await db.listRows('seat_ledger', [Query.equal('program_id', programId), Query.limit(1)])).rows[0]?.$id ?? '', 9), 'not_found');
    // A second visitor gets their own sandbox, never this one.
    const other = await openSandbox({ ...caller, ownerId: stranger.userId });
    expect(other.program.$id).not.toBe(programId);
    expect(other.program.sandbox_owner).toBe(stranger.userId);
    // And a production program is never treated as a sandbox.
    const production = (await db.listRows('programs', [Query.isNull('namespace'), Query.limit(1)])).rows[0];
    if (production) expect(() => { assertSandboxOf(production, visitor.userId); }).toThrow(AppError);
  });

  it('blocks a duplicate child through the unique index and raises a link request', async () => {
    const r = await duplicateChildDemo(caller);
    expect(r.outcome).toBe('possible_duplicate');
    expect(r.ticketsForChild).toBe(1);
    expect(r.linkRequests).toBeGreaterThanOrEqual(1);
    expect(r.steps.find((s) => s.op === 'createRow(tickets)')?.outcome).toBe('refused');
    const again = await duplicateChildDemo(caller);
    expect(again.ticketsForChild).toBe(1);
  });

  it('logs every privileged console change with actor, reason and audit entry', async () => {
    const queue = (await command({ action: 'verificationQueue' })) as { needsReview: number; items: { publicId: string; claimedTier: number; nearBoundary: boolean }[] };
    expect(queue.needsReview).toBeGreaterThanOrEqual(2);
    const edge = queue.items.find((i) => i.nearBoundary);
    if (!edge) throw new Error('scenario has near-boundary homes');
    const k = key();
    const verified = (await command({ action: 'verifyTier', publicId: edge.publicId, tier: 1, reasonCode: 'boundary_reviewed', idempotencyKey: k })) as { status: string; auditSeq: number };
    expect(verified.status).toBe('changed');
    expect(((await command({ action: 'verifyTier', publicId: edge.publicId, tier: 1, reasonCode: 'boundary_reviewed', idempotencyKey: k })) as { status: string }).status).toBe('replayed');

    const target = (await sandboxStatus(caller)).families.find((f) => f.key === 'garcia')?.publicId ?? '';
    const created = (await command({ action: 'createOverride', publicId: target, reasonCode: 'accommodation', pool: 'accommodation', idempotencyKey: key() })) as { status: string; inSnapshot: boolean };
    expect(created).toMatchObject({ status: 'changed', inSnapshot: true });
    await expectAppError(command({ action: 'createOverride', publicId: target, reasonCode: 'staff_family', pool: 'general', idempotencyKey: key() }), 'conflict');

    const log = (await command({ action: 'staffLog' })) as { entries: { action: string; actor: string; reasonCode: string | null; auditSeq: number | null; at: string }[] };
    const override = log.entries.find((e) => e.action === 'override_created');
    expect(override).toMatchObject({ actor: 'You', reasonCode: 'accommodation' });
    expect(override?.auditSeq).toBeGreaterThan(0);
    expect(Date.parse(override?.at ?? '')).toBeGreaterThan(0);
    const audit = await db.listRows('audit_log', [Query.equal('program_id', programId), Query.equal('seq', override?.auditSeq ?? 0)]);
    expect(audit.rows[0]?.event).toBe('override_created');
    expect(audit.rows[0]?.payload).not.toContain(visitor.userId); // pseudonymous staff_ref only
    // Task 14: the PUBLIC entry says an override exists, never why (an access or medical need).
    expect(audit.rows[0]?.payload).not.toMatch(/accommodation|reason_code|pool/);
    const row = (await command({ action: 'overrides' })) as { overrides: { publicId: string; createdBeforeFreeze: boolean; actor: string }[] };
    expect(row.overrides[0]).toMatchObject({ publicId: target, createdBeforeFreeze: true, actor: 'You' });
  });

  it('fast-forwards to the close and freezes the inputs, overrides included', async () => {
    const r = await closeApplications(caller);
    expect(r.status).toBe('frozen');
    const program = await db.getRow('programs', programId);
    expect(program.status).toBe('frozen');
    expect(program.demo_advanced_ms).toBeGreaterThan(24 * 3600_000);
    expect(Date.parse(program.window_close)).toBeLessThanOrEqual(Date.now() + 5000);
    const snap = (await db.listRows('frozen_inputs', [Query.equal('program_id', programId)])).rows[0];
    expect(snap?.overrides).toBe(1);
    const inputs = parseFrozenInputs(snap?.canonical ?? '').inputs;
    // Task 14 (draw-inputs-v2): the published inputs carry only THAT this receipt has an override.
    expect(inputs.schema).toBe('draw-inputs-v2');
    expect(Object.keys(inputs.overrides[0] ?? {})).toEqual(['publicId']);
    expect(snap?.canonical).not.toMatch(/accommodation|reasonCode|"pool"/);
    // The verified tier is in the snapshot too.
    expect(inputs.applications.some((a) => a.tier === 1)).toBe(true);
    await expectAppError(command({ action: 'createOverride', publicId: inputs.applications[0]?.publicId ?? '', reasonCode: 'staff_family', pool: 'general', idempotencyKey: key() }), 'locked');
    expect((await closeApplications(caller)).status).toBe('already_frozen');
  });

  it('draws once the announced drand round exists, through the production draw path', { timeout: 240_000 }, async () => {
    let last: Awaited<ReturnType<typeof runSandboxDraw>> | null = null;
    for (let i = 0; i < 30; i++) {
      last = await runSandboxDraw(caller);
      if (last.status.status === 'drawn' && last.status.offersIssuedAt) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect(last?.status.status).toBe('drawn');
    expect(last?.status.run?.beaconVerified).toBe(true);
    await assertSeatInvariants(programId);
    const fairness = (await command({ action: 'fairness' })) as { ready: boolean; report: { invariants: { oversoldSessions: unknown[]; duplicatePlacements: number; siblingSplits: number } } };
    expect(fairness.ready).toBe(true);
    expect(fairness.report.invariants).toMatchObject({ oversoldSessions: [], duplicatePlacements: 0, siblingSplits: 0 });
  });

  it('publishes the committed placements, and an independent replay reproduces them', { timeout: 120_000 }, async () => {
    const scope = [Query.equal('program_id', programId)];
    const [program, snapshots, runs, results, audit] = await Promise.all([
      db.getRow('programs', programId),
      db.listRows('frozen_inputs', scope),
      db.listRows('draw_runs', scope),
      db.listRows('draw_results', scope),
      db.listRows('audit_log', [...scope, Query.orderAsc('seq'), Query.limit(200)]),
    ]);
    const result = results.rows[0];
    expect(result?.placements).toBeGreaterThan(0);
    expect(snapshots.rows[0]?.application_order_hash).toMatch(/^[0-9a-f]{64}$/);
    // Idempotent: a second publish (e.g. the offers sweep backstop) returns the same row.
    expect(await publishDrawResult(db, programId)).toMatchObject({ status: 'already_published', resultHash: result?.result_hash });
    expect(audit.rows.filter((r) => r.event === 'result_published')).toHaveLength(1);
    expect(parseOutcomes(result?.outcomes ?? '').entries.length).toBeGreaterThanOrEqual(result?.placements ?? 0);
    // The browser's code path: public rows -> bundle -> replay (the stored beacon, BLS-verified locally).
    const rec: PublishedRecord = { program, snapshot: snapshots.rows[0] ?? null, run: runs.rows[0] ?? null, audit: audit.rows, result: result ?? null };
    const v = await replayBundle(bundleFromRecord(rec));
    expect(v.steps.filter((x) => x.status !== 'pass').map((x) => `${x.key}: ${x.summary} ${x.details.join(' ')}`)).toEqual([]);
    expect(v.replayMatches).toBe(true);
  });

  it('refuses a sibling pair into a full week and rolls back both seats', async () => {
    const r = await rollbackDemo(caller);
    expect(r.refused).toBe(true);
    expect(r.after).toEqual(r.before);
    expect(r.steps.find((s) => s.op === 'commit')?.detail).toMatch(/capacity_exceeded|limit/i);
    await assertSeatInvariants(programId);
  });

  it('replies for synthetic families and expires offers by moving demo time only', async () => {
    const status = await sandboxStatus(caller);
    const decliner = status.families.find((f) => f.offers.some((o) => o.status === 'offered'));
    if (!decliner?.publicId) throw new Error('someone has an offer');
    const declined = await respondAsSynthetic(caller, { publicId: decliner.publicId, response: 'decline' });
    expect(declined.result.status).toBe('changed');
    await assertSeatInvariants(programId);

    const pending = await db.listRows('placements', [Query.equal('program_id', programId), Query.equal('status', 'offered'), Query.limit(100)]);
    const r = await expireSandboxOffers(caller);
    expect(r.sweep.expired).toBeGreaterThan(0);
    // The sweep is time-boxed; the console's "process offers" finishes it, exactly as the UI does.
    for (let more = r.sweep.more, i = 0; more && i < 10; i++) more = ((await command({ action: 'processOffers' })) as { more: boolean }).more;
    const after = await Promise.all(pending.rows.map((p) => db.getRow('placements', p.$id)));
    expect(after.map((p) => p.status)).toEqual(pending.rows.map(() => 'expired'));
    // Only the sandbox's own deadlines moved: expiry was decided by Appwrite server time.
    expect(after.every((p, i) => Date.parse(p.expires_at ?? '') === Date.parse(pending.rows[i]?.expires_at ?? '') - 48 * 3600_000)).toBe(true);
    await assertSeatInvariants(programId);
    const program = await db.getRow('programs', programId);
    expect(program.demo_advanced_ms).toBeGreaterThan(48 * 3600_000);
  });

  it('keeps an intact audit chain for the whole demonstration', async () => {
    const { rows } = await db.listRows('audit_log', [Query.equal('program_id', programId), Query.orderAsc('seq'), Query.limit(200)]);
    expect(verifyChain(rows)).toEqual({ ok: true });
    const events = rows.map((r) => r.event);
    for (const e of ['program_published', 'tier_verified', 'override_created', 'drand_round_announced', 'inputs_frozen', 'beacon_verified', 'draw_completed', 'result_published', 'offers_issued', 'demo_time_advanced']) expect(events).toContain(e);
  });

  it('resets idempotently to a fresh seeded generation and deletes only the old sandbox', async () => {
    const actorBefore: ConsoleActor = await sandboxActor(caller);
    const k = key();
    const reset = await resetSandbox(caller, k);
    expect(reset.status).toBe('reset');
    expect(reset.programId).not.toBe(programId);
    expect((await resetSandbox(caller, k)).programId).toBe(reset.programId); // replay
    // Deleting the old generation is time-boxed per request; status calls finish it.
    for (let i = 0; i < 10 && (await sandboxStatus(caller)).cleanupPending > 0; i++);
    await expect(db.getRow('programs', programId)).rejects.toMatchObject({ mapped: { kind: 'not_found' } });
    for (const table of ['placements', 'applications', 'tickets', 'audit_log', 'staff_actions', 'seat_ledger'] as const) {
      expect((await db.listRows(table, [Query.equal('program_id', programId), Query.limit(1)])).total, table).toBe(0);
    }
    const fresh = await db.getRow('programs', reset.programId);
    expect(fresh).toMatchObject({ status: 'open', namespace: 'demo', sandbox_owner: visitor.userId });
    expect((await sandboxStatus(caller)).families.every((f) => f.publicId)).toBe(true);
    // The other visitor's sandbox is untouched.
    expect((await openSandbox({ ...caller, ownerId: stranger.userId })).program.status).toBe('open');
    expect(actorBefore.teamId).toBe((await sandboxActor(caller)).teamId);
  });
});
