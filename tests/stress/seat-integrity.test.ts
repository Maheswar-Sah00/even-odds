/**
 * Task 14 database stress suite against REAL TablesDB (.env.server). Every
 * scenario gets its own synthetic program, and every assertion is made on
 * COMMITTED rows re-read after the race, never on staged transaction values or
 * on what the racing calls returned. Each scenario also writes what it
 * observed (outcome counts, error kinds, committed counters, timings) to
 * docs/test-evidence/stress/<scenario>.json for docs/TEST-REPORT.md.
 *
 * Run: npm run test:stress   (minutes; real network; Free-plan quotas apply)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ID, Query } from 'node-appwrite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../functions/shared/app-error.ts';
import { applicationRowId, preferenceRowId } from '../../functions/shared/applications.ts';
import { newPublicId } from '../../functions/shared/crypto.ts';
import { buildDrawInputs, executeDrawRun, startDrawRun } from '../../functions/shared/draw-commit.ts';
import { guardianRowId, ticketRowId } from '../../functions/shared/household.ts';
import { respondToOffers } from '../../functions/shared/offer-actions.ts';
import { expireDueOffers, offerExitMarkerId, promoteWaitlist, runOfferSweep, seatReleaseMarkerId, transitionOffers } from '../../functions/shared/offers.ts';
import { createProgram, ledgerRowId, publishProgram, replaceSessions } from '../../functions/shared/organiser.ts';
import { placeGroup, type PlaceGroupResult } from '../../functions/shared/placement.ts';
import { transitionProgram } from '../../functions/shared/program-status.ts';
import { computePlan } from '../../shared/draw/index.ts';
import { ServiceError } from '../../shared/errors.ts';
import type { TableKey } from '../../shared/config.ts';
import { HOLDING_STATUSES, OFFER_TTL_MS, type OfferStatus } from '../../shared/offer-lifecycle.ts';
import { parseSessionsCsv, programDetailsSchema } from '../../shared/program-input.ts';
import { db, RUN_ID, serverEnv, syntheticProgram } from '../integration/helpers/server.ts';

const teamId = serverEnv.organiserTeamId ?? 'organisers';
const programs: string[] = [];
const key = () => randomUUID().replaceAll('-', '');
const short = (s: string) => s.slice(0, 36);
/** Server-only rows: these scenarios exercise seats, not row permissions (see permissions.test.ts). */
const NO_PERMS: string[] = [];

const CLEANUP: TableKey[] = ['placements', 'waitlist', 'idempotency', 'preferences', 'tickets', 'applications', 'seat_ledger', 'offer_stats', 'audit_log', 'draw_runs'];
afterAll(async () => {
  for (const programId of programs) {
    for (const t of CLEANUP) await db.deleteRowsWhere(t, [Query.equal('program_id', programId)]).catch(() => undefined);
    await db.deleteRowsWhere('guardians', [Query.startsWith('family_id', `fs-${programId.slice(4, 8)}`)]).catch(() => undefined);
    await db.deleteRow('programs', programId).catch(() => undefined);
  }
}, 900_000);

// ---- platform throttling -----------------------------------------------------------
// Appwrite Cloud answers a burst of hundreds of requests with some 429s, even for a server
// key (observed: 1 of 500). Races count those as outcomes; SETUP must not fail on them.
const isThrottled = (err: unknown) => err instanceof ServiceError && (err.mapped.kind === 'rate_limited' || err.mapped.kind === 'network');
async function unthrottled<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (!isThrottled(err) || attempt >= 8) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
// Let the previous scenario's burst drain before the next one sets up.
beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20_000));
  await unthrottled(() => db.listRows('programs', [Query.limit(1)]));
}, 300_000);

// ---- evidence ---------------------------------------------------------------------

// Outside test-results/, which Playwright empties on every run.
const OUT = 'docs/test-evidence/stress';
function record(scenario: string, data: Record<string, unknown>) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${scenario}.json`, JSON.stringify({ scenario, runId: RUN_ID, endpoint: serverEnv.endpoint, at: new Date().toISOString(), ...data }, null, 2));
}

const kindOf = (e: unknown) =>
  e instanceof ServiceError ? `service:${e.mapped.kind}:${String(e.mapped.status ?? '')}` : e instanceof AppError ? `app:${e.code}` : e instanceof Error ? `error:${e.message.slice(0, 80)}` : 'unknown';
const isTransient = (e: unknown) => e instanceof ServiceError && (e.mapped.kind === 'rate_limited' || e.mapped.kind === 'network');

/**
 * Fires every call at once and classifies what came back (results are NOT evidence of success).
 * Calls refused by platform throttling (429) or dropped connections are retried with jittered
 * backoff, as the app's clients do: every attempt eventually reaches the database, so the
 * scenario really is N competitors for the seat. `firstWave` records what the platform did to
 * the initial simultaneous burst.
 */
async function race<T>(calls: (() => Promise<T>)[]) {
  const started = Date.now();
  const firstWave: Record<string, number> = {};
  let retries = 0;
  const attempt = async (call: () => Promise<T>) => {
    for (let n = 1; ; n++) {
      try {
        return await call();
      } catch (err) {
        if (n === 1) firstWave[kindOf(err)] = (firstWave[kindOf(err)] ?? 0) + 1;
        if (!isTransient(err) || n >= 12) throw err;
        retries++;
        await new Promise((r) => setTimeout(r, Math.random() * 1000 * Math.min(2 ** n, 30)));
      }
    }
  };
  const settled = await Promise.allSettled(calls.map((c) => attempt(c)));
  const ok = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const errorKinds: Record<string, number> = {};
  for (const r of settled) if (r.status === 'rejected') errorKinds[kindOf(r.reason)] = (errorKinds[kindOf(r.reason)] ?? 0) + 1;
  return { ok, errorKinds, errors: settled.length - ok.length, firstWave, retries, ms: Date.now() - started };
}
const tally = (xs: { status: string }[]) => xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.status]: (acc[x.status] ?? 0) + 1 }), {});

// ---- committed state ----------------------------------------------------------------

async function all<K extends TableKey>(table: K, programId: string, extra: string[] = []) {
  const out = [];
  let cursor: string | undefined;
  for (;;) {
    const { rows } = await db.listRows(table, [Query.equal('program_id', programId), ...extra, Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])]);
    out.push(...rows);
    if (rows.length < 100) return out;
    cursor = rows.at(-1)?.$id;
  }
}

/** Reads committed rows and checks every seat invariant; returns the evidence. */
async function committed(programId: string, opts: { heldWeeks?: boolean } = {}) {
  const [ledgers, placements, prefs, waits] = await Promise.all([all('seat_ledger', programId), all('placements', programId), all('preferences', programId), all('waitlist', programId)]);
  const holding = placements.filter((p) => (HOLDING_STATUSES as readonly OfferStatus[]).includes(p.status));
  const perLedger = ledgers.map((l) => ({ ledger: `${l.week}/${l.age_group}`, capacity: l.capacity, taken: l.taken, holding: holding.filter((p) => p.ledger_id === l.$id).length }));
  for (const l of perLedger) {
    expect(l.taken, `${l.ledger}: taken must equal committed holding placements`).toBe(l.holding);
    expect(l.taken, `${l.ledger}: oversold`).toBeLessThanOrEqual(l.capacity);
  }
  // held_weeks is set when offers are issued (issueOffers), so a bare draw is checked without it.
  for (const p of opts.heldWeeks === false ? [] : prefs) {
    const n = holding.filter((h) => h.child_id === p.child_id).length;
    expect(p.held_weeks, `held_weeks of ${p.child_id}`).toBe(n);
    expect(n).toBeLessThanOrEqual(p.requested_weeks);
  }
  const seats = new Set(placements.map((p) => `${p.child_id}@${p.week}`));
  expect(seats.size, 'one placement per child and week').toBe(placements.length);
  for (const w of waits) expect(w.status === 'promoted', `waitlist ${w.child_id}@${w.week} is ${w.status}`).toBe(seats.has(`${w.child_id}@${w.week}`));
  return { ledgers: perLedger, placements: placements.length, holding: holding.length, waitlist: waits.length, promoted: waits.filter((w) => w.status === 'promoted').length };
}

// ---- builders (TEST-ONLY setup; seats are still taken only through placeGroup) ------

let worlds = 0;
async function world(sessions: [week: string, ageGroup: string, capacity: number][], status: 'drawn' | 'open' = 'drawn') {
  const programId = short(`its-${String(++worlds)}-${RUN_ID}`);
  programs.push(programId);
  await unthrottled(() => db.createRow('programs', programId, syntheticProgram({ status, org_team_id: teamId, ...(status === 'drawn' ? { offers_issued_at: new Date().toISOString() } : {}) })));
  await unthrottled(() => db.upsertRows(
    'seat_ledger',
    sessions.map(([week, ageGroup, capacity]) => ({
      $permissions: NO_PERMS, $id: ledgerRowId(programId, week, ageGroup), program_id: programId, week, week_start: '2027-06-14T00:00:00.000Z', age_group: ageGroup, min_age: 5, max_age: 12, capacity, taken: 0,
    })),
  ));
  return programId;
}

interface Fam { familyId: string; userId: string; kids: string[] }

/** Bulk-creates households with one application and preferences each (100 rows per request). */
async function families(programId: string, n: number, opts: { kids?: number; mode?: 'independent' | 'together_only'; prefix?: string } = {}): Promise<Fam[]> {
  const kidsEach = opts.kids ?? 1;
  const mode = opts.mode ?? 'independent';
  const tag = `${programId.slice(4, 8)}${opts.prefix ?? 'a'}`;
  const fams = Array.from({ length: n }, (_, i) => ({
    familyId: short(`fs-${tag}-${String(i)}-${RUN_ID}`),
    userId: short(`us-${tag}-${String(i)}-${RUN_ID}`),
    kids: Array.from({ length: kidsEach }, (_, k) => short(`cs-${tag}-${String(i)}-${String(k)}-${RUN_ID}`)),
  }));
  const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / 100) }, (_, i) => xs.slice(i * 100, i * 100 + 100));
  for (const c of chunks(fams.map((f) => ({ $permissions: NO_PERMS, $id: guardianRowId(f.userId), user_id: f.userId, family_id: f.familyId, role: 'primary' as const })))) await unthrottled(() => db.upsertRows('guardians', c));
  for (const c of chunks(fams.map((f) => ({ $permissions: NO_PERMS, $id: applicationRowId(programId, f.familyId), program_id: programId, family_id: f.familyId, public_id: newPublicId(), status: 'submitted' as const, sibling_mode: mode, synthetic: true })))) await unthrottled(() => db.upsertRows('applications', c));
  const prefs = fams.flatMap((f) => f.kids.map((childId) => ({ $permissions: NO_PERMS, $id: preferenceRowId(programId, childId), program_id: programId, family_id: f.familyId, child_id: childId, ranked_weeks: ['W1', 'W2'], requested_weeks: 1, held_weeks: 0 })));
  for (const c of chunks(prefs)) await unthrottled(() => db.upsertRows('preferences', c));
  return fams;
}

/** The real seat path: placeGroup, with held_weeks staged in the same transaction. */
const place = (programId: string, f: Fam, week: string, members: [childId: string, ageGroup: string][], idempotencyKey = `stress:${programId}:${week}:${f.familyId}`, ttlMs = OFFER_TTL_MS) =>
  placeGroup(db, {
    programId, familyId: f.familyId, week, members: members.map(([childId, ageGroup]) => ({ childId, ageGroup })), idempotencyKey, permissions: [], offerTtlMs: ttlMs, source: 'draw',
    stage: async (transactionId) => {
      for (const [childId] of members) await db.incrementRowColumn('preferences', preferenceRowId(programId, childId), 'held_weeks', { value: 1, max: 12, transactionId });
    },
  });

// ---- 1. one freed seat ----------------------------------------------------------------

describe('one freed seat', () => {
  it('500 simultaneous placements into one freed seat: exactly one commits', async () => {
    const p = await world([['W1', 'young', 1]]);
    const [holder, ...rest] = await families(p, 501);
    if (!holder) throw new Error('setup');
    const first = await place(p, holder, 'W1', [[holder.kids[0] ?? '', 'young']]);
    if (first.status !== 'placed') throw new Error('setup');
    const freed = await respondToOffers(db, holder.userId, { programId: p, placementIds: first.placementIds, response: 'decline', idempotencyKey: key() });
    expect(freed.status).toBe('changed');
    expect((await db.getRow('seat_ledger', ledgerRowId(p, 'W1', 'young'))).taken).toBe(0);

    const r = await race(rest.map((f) => () => place(p, f, 'W1', [[f.kids[0] ?? '', 'young']])));
    const state = await committed(p);
    const outcomes = tally(r.ok);
    record('one-seat-500-placements', { attempts: rest.length, outcomes, errorKinds: r.errorKinds, firstWave: r.firstWave, retries: r.retries, ms: r.ms, committed: state });
    // Exactly one seat; every other attempt got a truthful refusal. Under a sustained flood the
    // Free plan may still throttle a few after 12 retries: those never reached the database and
    // are reported, never counted as success.
    expect(outcomes.placed).toBe(1);
    expect((outcomes.no_capacity ?? 0) + (r.errorKinds['service:rate_limited:429'] ?? 0)).toBe(499);
    expect(Object.keys(r.errorKinds).filter((k) => k !== 'service:rate_limited:429')).toEqual([]);
    expect(state.ledgers[0]?.taken).toBe(1);
    expect(state.holding).toBe(1);
  }, 900_000);

  it('500 waitlisted families, 50 duplicate promotion jobs and 500 simultaneous accepts of the resulting offer', async () => {
    const p = await world([['W1', 'young', 1]]);
    const [holder, ...waiting] = await families(p, 501);
    if (!holder) throw new Error('setup');
    const first = await place(p, holder, 'W1', [[holder.kids[0] ?? '', 'young']]);
    if (first.status !== 'placed') throw new Error('setup');
    // Waitlist in lottery order (position 1 = first in line).
    for (let i = 0; i < waiting.length; i += 100) {
      await unthrottled(() => db.upsertRows('waitlist', waiting.slice(i, i + 100).map((f, j) => ({
        $permissions: NO_PERMS, $id: short(`ws-${String(i + j)}-${RUN_ID}`), program_id: p, week: 'W1', age_group: 'young', family_id: f.familyId, child_id: f.kids[0] ?? '', position: i + j + 1, rank: i + j + 1, status: 'waiting' as const,
      }))));
    }
    // The decline is committed first; then 50 sweeps race to promote into the single freed seat.
    await transitionOffers(db, { programId: p, placementIds: first.placementIds, to: 'declined', clock: 'before_expiry' });
    const sweeps = await race(Array.from({ length: 50 }, () => () => promoteWaitlist(db, p, { deadline: Date.now() + 120_000 })));
    const promotedCalls = sweeps.ok.reduce((n, x) => n + x.promoted.length, 0);
    const winner = waiting[0];
    if (!winner) throw new Error('setup');
    const winnerOffer = (await all('placements', p, [Query.equal('child_id', winner.kids[0] ?? '')]))[0];
    expect(winnerOffer?.status, 'position 1 is promoted').toBe('offered');

    // 500 simultaneous accepts: 250 retries of one click (same key) + 250 distinct clicks.
    const same = key();
    const accepts = await race(Array.from({ length: 500 }, (_, i) => () =>
      respondToOffers(db, winner.userId, { programId: p, placementIds: [winnerOffer?.$id ?? ''], response: 'accept', idempotencyKey: i < 250 ? same : key() })));
    // An outsider forging the same placement ID is refused.
    const outsider = waiting[1];
    const forged = await respondToOffers(db, outsider?.userId ?? '', { programId: p, placementIds: [winnerOffer?.$id ?? ''], response: 'decline', idempotencyKey: key() }).then(() => 'accepted', (e: unknown) => (e instanceof AppError ? e.code : 'error'));

    const state = await committed(p);
    const exits = await all('idempotency', p, [Query.equal('$id', offerExitMarkerId(winnerOffer?.$id ?? '', 'offered'))]);
    record('one-seat-500-waitlist-50-sweeps-500-accepts', {
      waitlisted: waiting.length, sweeps: { calls: 50, promotedReported: promotedCalls, errorKinds: sweeps.errorKinds, firstWave: sweeps.firstWave, retries: sweeps.retries, ms: sweeps.ms },
      accepts: { calls: 500, outcomes: tally(accepts.ok), errorKinds: accepts.errorKinds, firstWave: accepts.firstWave, retries: accepts.retries, ms: accepts.ms }, forgedOfferResponse: forged, committed: state,
    });
    expect(state.promoted).toBe(1);
    expect(state.ledgers[0]?.taken).toBe(1);
    expect((await db.getRow('placements', winnerOffer?.$id ?? '')).status).toBe('accepted');
    expect(accepts.errors).toBe(0);
    expect(sweeps.errors).toBe(0);
    expect(tally(accepts.ok).changed ?? 0).toBe(1);
    expect(exits.length).toBe(1);
    expect(forged).toBe('not_found');
  }, 900_000);
});

// ---- 2. many applicants, nearly full session ------------------------------------------

describe('a nearly full session', () => {
  it('150 households (100 singles, 50 sibling pairs) race for the last 5 seats', async () => {
    const p = await world([['W1', 'young', 40]]);
    const seeded = await families(p, 35);
    for (const f of seeded) await place(p, f, 'W1', [[f.kids[0] ?? '', 'young']]);
    const singles = await families(p, 100, { prefix: 's' });
    const pairs = await families(p, 50, { kids: 2, prefix: 'p' });
    const r = await race<PlaceGroupResult>([
      ...singles.map((f) => () => place(p, f, 'W1', [[f.kids[0] ?? '', 'young']])),
      ...pairs.map((f) => () => place(p, f, 'W1', f.kids.map((c) => [c, 'young'] as [string, string]))),
    ]);
    const state = await committed(p);
    const rows = await all('placements', p);
    const splitPairs = pairs.filter((f) => rows.filter((x) => f.kids.includes(x.child_id)).length === 1).length;
    record('nearly-full-150-households', { capacity: 40, preTaken: 35, outcomes: tally(r.ok), errorKinds: r.errorKinds, firstWave: r.firstWave, retries: r.retries, ms: r.ms, splitPairs, committed: state });
    expect(splitPairs).toBe(0);
    expect(state.ledgers[0]?.taken).toBeLessThanOrEqual(40);
    expect(state.ledgers[0]?.taken).toBeGreaterThanOrEqual(39); // singles always fill a remaining seat
  }, 900_000);
});

// ---- 3. sibling groups across two ledgers -----------------------------------------------

describe('concurrent sibling groups', () => {
  it('60 young+old sibling pairs and 10 young singles: all-or-nothing, never oversold', async () => {
    const p = await world([['W1', 'young', 6], ['W1', 'old', 4]]);
    const pairs = await families(p, 60, { kids: 2, mode: 'together_only' });
    const singles = await families(p, 10, { prefix: 's' });
    const r = await race<PlaceGroupResult>([
      ...pairs.map((f) => () => place(p, f, 'W1', [[f.kids[0] ?? '', 'young'], [f.kids[1] ?? '', 'old']])),
      ...singles.map((f) => () => place(p, f, 'W1', [[f.kids[0] ?? '', 'young']])),
    ]);
    const state = await committed(p);
    const rows = await all('placements', p);
    const placedPairs = pairs.filter((f) => rows.some((x) => x.child_id === f.kids[0]) && rows.some((x) => x.child_id === f.kids[1])).length;
    const splitPairs = pairs.filter((f) => rows.some((x) => x.child_id === f.kids[0]) !== rows.some((x) => x.child_id === f.kids[1])).length;
    const young = state.ledgers.find((l) => l.ledger === 'W1/young');
    const old = state.ledgers.find((l) => l.ledger === 'W1/old');
    record('siblings-60-pairs-10-singles', { outcomes: tally(r.ok), errorKinds: r.errorKinds, firstWave: r.firstWave, retries: r.retries, ms: r.ms, placedPairs, splitPairs, committed: state });
    expect(splitPairs).toBe(0);
    expect(old?.taken).toBe(placedPairs);
    expect(young?.taken).toBe(6);
  }, 900_000);
});

// ---- 4. transaction conflicts and retries ---------------------------------------------------

describe('transaction conflicts and retries', () => {
  it('40 copies of one request (one idempotency key): one seat, the rest replay', async () => {
    const p = await world([['W1', 'young', 5]]);
    const [f] = await families(p, 1);
    if (!f) throw new Error('setup');
    const r = await race(Array.from({ length: 40 }, () => () => place(p, f, 'W1', [[f.kids[0] ?? '', 'young']], `dup:${p}`)));
    const state = await committed(p);
    record('duplicate-key-40', { outcomes: tally(r.ok), errorKinds: r.errorKinds, firstWave: r.firstWave, retries: r.retries, ms: r.ms, committed: state });
    expect(state.ledgers[0]?.taken).toBe(1);
    expect(tally(r.ok).placed ?? 0).toBeLessThanOrEqual(1);
  }, 600_000);

  it('30 un-keyed accepts of one offer with 2 attempts each: one commit, nobody else claims "changed"', async () => {
    const p = await world([['W1', 'young', 1]]);
    const [f] = await families(p, 1);
    if (!f) throw new Error('setup');
    const res = await place(p, f, 'W1', [[f.kids[0] ?? '', 'young']]);
    if (res.status !== 'placed') throw new Error('setup');
    const r = await race(Array.from({ length: 30 }, () => () => transitionOffers(db, { programId: p, placementIds: res.placementIds, to: 'accepted', clock: 'before_expiry' }, { maxAttempts: 2, baseDelayMs: 50 })));
    const attempts = r.ok.reduce<Record<string, number>>((acc, x) => ({ ...acc, [String(x.attempts)]: (acc[String(x.attempts)] ?? 0) + 1 }), {});
    const state = await committed(p);
    const markers = await all('idempotency', p, [Query.equal('$id', [offerExitMarkerId(res.placementIds[0] ?? '', 'offered'), seatReleaseMarkerId(res.placementIds[0] ?? '')])]);
    record('conflicting-accepts-30', { outcomes: tally(r.ok), attempts, errorKinds: r.errorKinds, firstWave: r.firstWave, retries: r.retries, ms: r.ms, exitMarkers: markers.length, committed: state });
    expect(tally(r.ok).changed).toBe(1);
    expect(markers.length).toBe(1);
    expect((await db.getRow('placements', res.placementIds[0] ?? '')).status).toBe('accepted');
    // Any failure must be an honest conflict, never a silent success.
    for (const k of Object.keys(r.errorKinds)) expect(k).toMatch(/transaction_conflict|app:conflict/);
  }, 600_000);
});

// ---- 5. draw workers ------------------------------------------------------------------------

const DRAW_CSV = 'week,week_start,age_group,min_age,max_age,capacity\nW1,2027-06-21,young,5,7,6\nW1,2027-06-21,old,8,10,4\nW2,2027-06-28,young,5,7,5\nW2,2027-06-28,old,8,10,4\n';
const SEED = 'feed'.repeat(16);

async function drawScenario(name: string, n: number) {
  const programId = short(`itsd-${name}-${RUN_ID}`);
  programs.push(programId);
  const now = Date.now();
  await createProgram(db, teamId, programDetailsSchema.parse({ name: `[SYNTHETIC] stress draw ${name}`, timezone: 'UTC', windowOpen: new Date(now - 7200_000).toISOString(), windowClose: new Date(now + 2 * 86400_000).toISOString(), maxWeeks: 2, defaultTier: 1, tierLabels: { '0': 'A', '1': 'B' } }), { programId, synthetic: true });
  await replaceSessions(db, teamId, programId, parseSessionsCsv(DRAW_CSV).sessions);
  await publishProgram(db, teamId, programId);
  const apps = [], tickets = [], prefs = [];
  for (let i = 0; i < n; i++) {
    const familyId = short(`fsd-${name}-${String(i)}-${RUN_ID}`);
    const kids = i % 4 === 0 ? 2 : 1;
    apps.push({ $permissions: NO_PERMS, $id: applicationRowId(programId, familyId), program_id: programId, family_id: familyId, public_id: newPublicId(), status: 'submitted' as const, claimed_tier: i % 3 === 0 ? 0 : 1, synthetic: true, sibling_mode: kids > 1 ? ('together_only' as const) : ('independent' as const) });
    for (let k = 0; k < kids; k++) {
      const childId = short(`csd-${name}-${String(i)}-${String(k)}-${RUN_ID}`);
      const group = (i + k) % 2 === 0 ? 'young' : 'old';
      tickets.push({ $permissions: NO_PERMS, $id: ticketRowId(programId, childId), program_id: programId, child_id: childId, family_id: familyId, child_key: newPublicId() + newPublicId() });
      prefs.push({ $permissions: NO_PERMS, $id: preferenceRowId(programId, childId), program_id: programId, family_id: familyId, child_id: childId, ranked_weeks: i % 2 ? ['W1', 'W2'] : ['W2', 'W1'], ranked_age_groups: [group, group], requested_weeks: 1 + (i % 2) });
    }
  }
  for (const [t, rows] of [['applications', apps], ['tickets', tickets], ['preferences', prefs]] as const) {
    for (let i = 0; i < rows.length; i += 100) await db.upsertRows(t, rows.slice(i, i + 100));
  }
  await transitionProgram(db, programId, 'frozen');
  const ctx = await buildDrawInputs(db, await db.getRow('programs', programId));
  const runId = ID.unique();
  await startDrawRun(db, { programId, drawRunId: runId, seedHex: SEED, drandRound: 1, inputs: ctx.inputs });
  return { programId, ctx, runId, plan: computePlan(ctx.inputs, SEED) };
}

describe('draw workers', () => {
  it('4 overlapping workers with tiny budgets and a lost cursor all complete with exactly the plan', async () => {
    const { programId, ctx, runId, plan } = await drawScenario('workers', 60);
    let tick = 0;
    const outcomes: string[] = [];
    const errorKinds: Record<string, number> = {};
    let interrupted = 0;
    const worker = async (id: number) => {
      for (let i = 0; i < 200; i++) {
        try {
          const out = await executeDrawRun(db, runId, ctx, { concurrency: 2, timeBudgetMs: 1, now: () => (tick += 1) });
          outcomes.push(`${String(id)}:${out.status}`);
          if (out.status !== 'running') return out.status;
        } catch (err) {
          // A dropped connection or throttling interrupts this worker mid-run: like the next
          // scheduled tick, it simply resumes (another interruption the run must survive).
          if (isTransient(err)) {
            interrupted++;
            continue;
          }
          const k = err instanceof AppError ? `app:${err.code}` : err instanceof ServiceError ? `service:${err.mapped.kind}` : 'error';
          errorKinds[k] = (errorKinds[k] ?? 0) + 1;
          return 'threw';
        }
        // Interruption: a crash that lost the cursor once, mid-run.
        if (id === 0 && i === 3) await db.updateRow('draw_runs', runId, { cursor: 0 });
      }
      return 'gave-up';
    };
    const finals = await Promise.all([0, 1, 2, 3].map(worker));
    const run = await db.getRow('draw_runs', runId);
    const rows = await all('placements', programId);
    const plannedSet = plan.steps.flatMap((s) => s.placements.map((x) => `${ctx.children.get(x.childRef)?.childId ?? '?'}@${x.week}`)).sort();
    const state = await committed(programId, { heldWeeks: false });
    record('draw-4-workers', { steps: plan.steps.length, finals, errorKinds, interrupted, runStatus: run.status, runError: run.error ?? null, programStatus: (await db.getRow('programs', programId)).status, committed: state });
    // Overlapping workers must neither fail the run nor see each other's progress as an error.
    expect(errorKinds).toEqual({});
    expect(finals.every((f) => f === 'completed'), finals.join(',')).toBe(true);
    expect(rows.map((x) => `${x.child_id}@${x.week}`).sort()).toEqual(plannedSet);
    expect(state.waitlist).toBe(plan.waitlist.length);
    expect(run.status).toBe('completed');
    expect((await db.getRow('programs', programId)).status).toBe('drawn');
  }, 900_000);
});

// ---- 6. duplicate expiry and waitlist jobs ---------------------------------------------------

describe('duplicate expiry and waitlist jobs', () => {
  it('20 expired offers, 30 waitlisted, 8 sweeps + 4 expiry + 4 promotion jobs at once', async () => {
    const p = await world([['W1', 'young', 12], ['W1', 'old', 8]]);
    const holders = await families(p, 20);
    for (const [i, f] of holders.entries()) {
      const res = await place(p, f, 'W1', [[f.kids[0] ?? '', i < 12 ? 'young' : 'old']], undefined, -1000);
      if (res.status !== 'placed') throw new Error('setup');
    }
    const waiting = await families(p, 30, { prefix: 'w' });
    await unthrottled(() => db.upsertRows('waitlist', waiting.map((f, i) => ({
      $permissions: NO_PERMS, $id: short(`wd-${String(i)}-${RUN_ID}`), program_id: p, week: 'W1', age_group: i % 2 ? 'old' : 'young', family_id: f.familyId, child_id: f.kids[0] ?? '', position: Math.floor(i / 2) + 1, rank: i + 1, status: 'waiting' as const,
    }))));
    const deadline = () => Date.now() + 240_000;
    const r = await race<unknown>([
      ...Array.from({ length: 8 }, () => () => runOfferSweep(db, { deadline: deadline(), programId: p })),
      ...Array.from({ length: 4 }, () => () => expireDueOffers(db, { deadline: deadline(), programId: p })),
      ...Array.from({ length: 4 }, () => () => promoteWaitlist(db, p, { deadline: deadline() })),
    ]);
    // Finish anything a sweep left for "next time", then read committed state.
    await runOfferSweep(db, { deadline: deadline(), programId: p });
    const state = await committed(p);
    const markers = await all('idempotency', p, [Query.equal('scope', 'seat-release')]);
    const promoted = (await all('waitlist', p, [Query.equal('status', 'promoted')])).map((w) => `${w.age_group}#${String(w.position)}`).sort();
    record('duplicate-jobs-16', { jobs: 16, errorKinds: r.errorKinds, firstWave: r.firstWave, retries: r.retries, ms: r.ms, releaseMarkers: markers.length, promoted, committed: state });
    expect(markers.length).toBe(20);
    expect(state.promoted).toBe(20);
    // Strict order: positions 1..12 young and 1..8 old, nobody skipped.
    expect(promoted).toEqual([...Array.from({ length: 8 }, (_, i) => `old#${String(i + 1)}`), ...Array.from({ length: 12 }, (_, i) => `young#${String(i + 1)}`)].sort());
  }, 900_000);
});
