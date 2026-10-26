/**
 * Task 10 freeze-and-verify protocol against REAL TablesDB and the REAL drand
 * network. Each scenario gets its own synthetic program.
 *
 * Programs whose beacon must already exist are moved into the past (see
 * helpers/freeze-scenario.ts); the freeze then runs with an injected clock
 * just after that close.
 */
import { Query } from 'node-appwrite';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '../../functions/shared/app-error.ts';
import { verifyChain } from '../../functions/shared/audit.ts';
import { executeDrawRun } from '../../functions/shared/draw-commit.ts';
import {
  freezeProgram,
  frozenInputsRowId,
  loadFrozenContext,
  protocolDrawRunId,
  recordDrawOutcome,
  resolveBeacon,
  seedProvenanceProblem,
} from '../../functions/shared/freeze.ts';
import { applicationWindow } from '../../functions/shared/household.ts';
import { ledgerRowId, setCapacity } from '../../functions/shared/organiser.ts';
import { transitionProgram } from '../../functions/shared/program-status.ts';
import { computePlan, planHash } from '../../shared/draw/index.ts';
import { frozenInputsHash, parseFrozenInputs } from '../../shared/freeze/canonical.ts';
import { announcedRound, deriveSeed, DRAND_CHAIN, fetchBeaconFromRelays, freezeDeadlineMs, roundTimeMs, verifyBeacon } from '../../shared/freeze/drand.ts';
import { QUICKNET_1000000, QUICKNET_12345678 } from '../fixtures/drand-beacons.ts';
import { auditOf, cleanupScenarios, PAST_ROUND, runsOf, scenario, snapshotsOf, teamId } from './helpers/freeze-scenario.ts';
import { browserGuest, db, serverEnv } from './helpers/server.ts';

afterAll(cleanupScenarios);

describe('announcement and freeze (real TablesDB)', () => {
  it('publishing commits to the drand round given by the window close, and logs it', async () => {
    const { programId, program } = await scenario('announce', { families: 1 });
    expect(program.drand_round).toBe(announcedRound(program.window_close));
    expect(program.drand_chain).toBe(DRAND_CHAIN.hash);
    expect(roundTimeMs(program.drand_round ?? 0)).toBeGreaterThan(Date.parse(program.window_close));
    const published = (await auditOf(programId)).find((e) => e.event === 'program_published');
    expect(JSON.parse(published?.payload ?? '{}')).toMatchObject({ drand_chain: DRAND_CHAIN.hash, drand_round: program.drand_round });
  });

  it('refuses to freeze while applications are open, and once it is too close to the round', async () => {
    const { programId, program } = await scenario('timing', { families: 1 });
    await expect(freezeProgram(db, programId)).rejects.toMatchObject({ code: 'locked', message: expect.stringMatching(/only be frozen after they close/) as unknown });
    const tooLate = new Date(freezeDeadlineMs(program.drand_round ?? 0) + 1000);
    await expect(freezeProgram(db, programId, { now: tooLate })).rejects.toMatchObject({ code: 'locked', message: expect.stringMatching(/Too late to freeze safely/) as unknown });
    expect((await db.getRow('programs', programId)).status).toBe('open');
    expect(await snapshotsOf(programId)).toEqual([]);
  });

  it('freezes in one transaction: status, public snapshot, pending draw run and audit entry', async () => {
    const { programId, afterClose } = await scenario('once');
    const result = await freezeProgram(db, programId, { now: afterClose });
    expect(result.status).toBe('frozen');
    expect(result.driftDetected).toBe(false);

    const program = await db.getRow('programs', programId);
    const snap = await db.getRow('frozen_inputs', frozenInputsRowId(programId));
    expect(program).toMatchObject({ status: 'frozen', inputs_hash: result.inputsHash });
    expect(frozenInputsHash(snap.canonical)).toBe(result.inputsHash);
    expect(parseFrozenInputs(snap.canonical).hash).toBe(result.inputsHash);
    expect(snap).toMatchObject({ format: 'even-odds-frozen-inputs-v1', algorithm: 'even-odds-draw-v1', applications: 6, children: 8, sessions: 4, seats: 9, overrides: 0, drand_round: program.drand_round });
    expect(new Date(snap.frozen_at).toISOString()).toBe(afterClose.toISOString());
    expect(result.frozenAt).toBe(afterClose.toISOString()); // normalised to the protocol's UTC "Z" format
    // Pseudonymous: no family, child or household identifiers in the published bytes.
    expect(snap.canonical).not.toMatch(/ff-once|cf-once|child_key/);

    const run = await db.getRow('draw_runs', protocolDrawRunId(programId));
    expect(run).toMatchObject({ status: 'pending', seed: null, inputs_hash: result.inputsHash, drand_round: program.drand_round, seed_scheme: 'even-odds-seed-v1' });

    const audit = await auditOf(programId);
    expect(verifyChain(audit)).toEqual({ ok: true });
    const frozen = audit.filter((e) => e.event === 'inputs_frozen');
    expect(frozen).toHaveLength(1);
    expect(JSON.parse(frozen[0]?.payload ?? '{}')).toMatchObject({ inputs_hash: result.inputsHash, drand_round: program.drand_round, applications: 6, override_counts: {} });

    // Anyone can read the published snapshot with the browser SDK.
    const guest = browserGuest();
    const pub = await guest.tablesDB.listRows({ databaseId: serverEnv.databaseId, tableId: 'frozen_inputs', queries: [Query.equal('program_id', programId)] });
    expect(pub.rows[0]?.inputs_hash).toBe(result.inputsHash);
  });

  it('repeated freeze requests return the same snapshot and change nothing', async () => {
    const { programId, afterClose } = await scenario('repeat', { families: 3 });
    const first = await freezeProgram(db, programId, { now: afterClose });
    const auditBefore = (await auditOf(programId)).length;
    for (let i = 0; i < 3; i++) {
      const again = await freezeProgram(db, programId, { now: new Date(afterClose.getTime() + (i + 1) * 60_000) });
      expect(again).toMatchObject({ status: 'already_frozen', inputsHash: first.inputsHash, frozenAt: first.frozenAt, drawRunId: first.drawRunId });
    }
    expect(await auditOf(programId)).toHaveLength(auditBefore);
    expect(await snapshotsOf(programId)).toHaveLength(1);
    expect(await runsOf(programId)).toHaveLength(1);
  });

  it('concurrent freeze attempts produce exactly one snapshot, and every caller gets it', async () => {
    const { programId, afterClose } = await scenario('race', { families: 4 });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => freezeProgram(db, programId, { now: new Date(afterClose.getTime() + i * 1000) })));
    expect(results.filter((r) => r.status === 'frozen')).toHaveLength(1);
    expect(new Set(results.map((r) => r.inputsHash)).size).toBe(1);
    expect(new Set(results.map((r) => r.frozenAt)).size).toBe(1);
    expect(await snapshotsOf(programId)).toHaveLength(1);
    expect(await runsOf(programId)).toHaveLength(1);
    const audit = await auditOf(programId);
    expect(audit.filter((e) => e.event === 'inputs_frozen')).toHaveLength(1);
    expect(verifyChain(audit)).toEqual({ ok: true });
  });

  it('locks inputs: no application window, capacity or status rollback; later row edits cannot change the snapshot', async () => {
    const { programId, afterClose } = await scenario('locks', { families: 2 });
    const frozen = await freezeProgram(db, programId, { now: afterClose });
    const program = await db.getRow('programs', programId);
    expect(applicationWindow(program, afterClose)).toEqual({ open: false, late: false });
    await expect(setCapacity(db, teamId, programId, ledgerRowId(programId, 'W1', 'young'), 10)).rejects.toMatchObject({ code: 'locked' });
    await expect(transitionProgram(db, programId, 'open')).rejects.toBeInstanceOf(AppError);

    // Even a direct edit with the server key (outside every application path) does not reach the draw inputs.
    const pref = (await db.listRows('preferences', [Query.equal('program_id', programId), Query.limit(1)])).rows[0];
    if (!pref) throw new Error('fixture: expected a preference');
    await db.updateRow('preferences', pref.$id, { requested_weeks: 2, ranked_weeks: ['W2'], ranked_age_groups: ['old'] });
    expect(await freezeProgram(db, programId, { now: afterClose })).toMatchObject({ status: 'already_frozen', inputsHash: frozen.inputsHash });
    // The draw reads the published snapshot, not the edited row.
    const ctx = await loadFrozenContext(db, await db.getRow('programs', programId));
    if (!ctx) throw new Error('expected a frozen snapshot');
    expect(computePlan(ctx.inputs, 'a'.repeat(64)).inputsHash).toBe(frozen.inputsHash);
  });
});

describe('beacon verification and the draw (real drand network + TablesDB)', () => {
  it('fetches the announced round from drand, verifies it, derives the seed, draws, and replays identically', async () => {
    const { programId, afterClose } = await scenario('e2e', { past: true, families: 8 });
    const frozen = await freezeProgram(db, programId, { now: afterClose });
    expect(frozen.drandRound).toBe(PAST_ROUND);

    const beacon = await resolveBeacon(db, frozen.drawRunId); // real HTTPS to the drand relays
    expect(beacon.status).toBe('verified');
    const run = await db.getRow('draw_runs', frozen.drawRunId);
    expect(run).toMatchObject({ beacon_verified: true, beacon_randomness: QUICKNET_1000000.randomness, beacon_signature: QUICKNET_1000000.signature, drand_chain: DRAND_CHAIN.hash });
    const program = await db.getRow('programs', programId);
    expect(await seedProvenanceProblem(run, program)).toBeNull();

    // Repeating the beacon step is safe.
    expect(await resolveBeacon(db, frozen.drawRunId)).toMatchObject({ status: 'already_verified', seed: run.seed });

    const ctx = await loadFrozenContext(db, program);
    if (!ctx) throw new Error('expected a frozen snapshot');
    const outcome = await executeDrawRun(db, frozen.drawRunId, ctx, { concurrency: 3 });
    expect(outcome.status).toBe('completed');
    const done = await db.getRow('draw_runs', frozen.drawRunId);
    await recordDrawOutcome(db, done);
    await recordDrawOutcome(db, done); // idempotent

    // An independent auditor: fetch the beacon themselves, verify it, re-derive the seed from the PUBLISHED inputs, recompute the plan.
    const snap = await db.getRow('frozen_inputs', frozenInputsRowId(programId));
    const fetched = await fetchBeaconFromRelays(PAST_ROUND);
    if (fetched.status !== 'ok') throw new Error(fetched.detail);
    const check = await verifyBeacon(fetched.beacon, PAST_ROUND);
    if (!check.ok) throw new Error(check.reason);
    const { inputs, hash } = parseFrozenInputs(snap.canonical);
    const seed = deriveSeed({ chainHash: DRAND_CHAIN.hash, round: PAST_ROUND, randomness: check.beacon.randomness, inputsHash: hash, programId });
    expect(seed).toBe(done.seed);
    const replay = computePlan(inputs, seed);
    expect(planHash(replay)).toBe(done.plan_hash);
    const placements = await db.listRows('placements', [Query.equal('program_id', programId), Query.limit(500)]);
    expect(placements.total).toBe(replay.summary.placements);

    const audit = await auditOf(programId);
    expect(verifyChain(audit)).toEqual({ ok: true });
    expect(audit.map((e) => e.event)).toEqual(['program_published', 'inputs_frozen', 'beacon_verified', 'draw_completed']);
    expect(JSON.parse(audit[2]?.payload ?? '{}')).toMatchObject({ drand_round: PAST_ROUND, randomness: QUICKNET_1000000.randomness, seed: done.seed, inputs_hash: hash });
    expect((await db.getRow('programs', programId)).status).toBe('drawn');
  });

  it('keeps the draw pending on an invalid signature, a different round, or no network, and never substitutes randomness', async () => {
    const { programId, afterClose } = await scenario('bad', { past: true, families: 2 });
    const frozen = await freezeProgram(db, programId, { now: afterClose });
    const runId = frozen.drawRunId;
    const serve = (beacon: unknown) => () => Promise.resolve({ status: 'ok' as const, beacon, relay: 'https://test-relay' });

    const tampered = { ...QUICKNET_1000000, signature: QUICKNET_1000000.signature.replace(/^8/, '9') };
    expect(await resolveBeacon(db, runId, { fetchBeacon: serve(tampered) })).toMatchObject({ status: 'rejected' });
    expect(await resolveBeacon(db, runId, { fetchBeacon: serve({ ...QUICKNET_1000000, randomness: QUICKNET_12345678.randomness }) })).toMatchObject({ status: 'rejected' });
    expect(await resolveBeacon(db, runId, { fetchBeacon: serve(QUICKNET_12345678) })).toMatchObject({ status: 'rejected', detail: expect.stringMatching(/not the announced round/) as unknown });
    const offline = await resolveBeacon(db, runId, { fetchBeacon: (r) => fetchBeaconFromRelays(r, { relays: ['https://drand-relay.invalid'], timeoutMs: 3000 }) });
    expect(offline.status).toBe('unavailable');

    const run = await db.getRow('draw_runs', runId);
    expect(run).toMatchObject({ status: 'pending', seed: null, beacon_attempts: 4 });
    expect(run.beacon_verified ?? false).toBe(false);
    expect(run.beacon_last_error).toMatch(/^unavailable:/);
    expect((await auditOf(programId)).some((e) => e.event === 'beacon_verified')).toBe(false);
    expect((await db.getRow('programs', programId)).status).toBe('frozen');

    // A seed written directly (bypassing verification) is refused by the provenance check that guards the draw.
    await db.updateRow('draw_runs', runId, { seed: 'f'.repeat(64) });
    expect(await seedProvenanceProblem(await db.getRow('draw_runs', runId), await db.getRow('programs', programId))).toMatch(/verified beacon/);
    await db.updateRow('draw_runs', runId, { seed: 'f'.repeat(64), beacon_verified: true, beacon_randomness: QUICKNET_1000000.randomness, beacon_signature: QUICKNET_1000000.signature });
    expect(await seedProvenanceProblem(await db.getRow('draw_runs', runId), await db.getRow('programs', programId))).toMatch(/does not match the seed derived/);
  });

  it('waits without contacting drand while the announced round is in the future', async () => {
    const { programId, afterClose } = await scenario('waiting', { families: 1 });
    const frozen = await freezeProgram(db, programId, { now: afterClose });
    const outcome = await resolveBeacon(db, frozen.drawRunId, { fetchBeacon: () => Promise.reject(new Error('must not be called')) });
    expect(outcome).toMatchObject({ status: 'waiting', round: frozen.drandRound });
    expect((await db.getRow('draw_runs', frozen.drawRunId)).seed).toBeNull();
  });

  it('concurrent beacon resolution stores one seed and one audit entry', async () => {
    const { programId, afterClose } = await scenario('beaconrace', { past: true, families: 2 });
    const frozen = await freezeProgram(db, programId, { now: afterClose });
    const fetchFixture = () => Promise.resolve({ status: 'ok' as const, beacon: QUICKNET_1000000, relay: 'fixture' });
    const results = await Promise.all(Array.from({ length: 4 }, () => resolveBeacon(db, frozen.drawRunId, { fetchBeacon: fetchFixture })));
    expect(results.filter((r) => r.status === 'verified').length).toBeGreaterThanOrEqual(1);
    expect(new Set(results.map((r) => ('seed' in r ? r.seed : null))).size).toBe(1);
    const audit = await auditOf(programId);
    expect(audit.filter((e) => e.event === 'beacon_verified')).toHaveLength(1);
    expect(verifyChain(audit)).toEqual({ ok: true });
  });
});
