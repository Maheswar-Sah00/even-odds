/**
 * Task 11 offers and waitlist against REAL TablesDB (.env.server). Each
 * scenario gets its own synthetic program. Programs are created directly in
 * the "drawn" state with offers issued (TEST-ONLY setup, labelled); seats are
 * still only taken through placeGroup(), so ledgers stay authoritative. The
 * end-to-end case at the bottom runs the real draw first.
 *
 * After every scenario assertInvariants() checks, from committed rows:
 * taken == offers holding the ledger <= capacity, held_weeks == weeks held
 * <= requested, and waitlist status agrees with placements.
 */
import { randomUUID } from 'node:crypto';
import { ID, Query } from 'node-appwrite';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '../../functions/shared/app-error.ts';
import { applicationRowId, preferenceRowId } from '../../functions/shared/applications.ts';
import { newPublicId } from '../../functions/shared/crypto.ts';
import { buildDrawInputs, executeDrawRun, startDrawRun } from '../../functions/shared/draw-commit.ts';
import { guardianRowId, ticketRowId } from '../../functions/shared/household.ts';
import { cancelOffers, familyOffers, organiserOffersOverview, respondToOffers } from '../../functions/shared/offer-actions.ts';
import {
  expireDueOffers,
  issueOffers,
  offerExitMarkerId,
  promoteWaitlist,
  runOfferSweep,
  seatReleaseMarkerId,
  serverNow,
  transitionOffers,
} from '../../functions/shared/offers.ts';
import { createProgram, ledgerRowId, publishProgram, replaceSessions } from '../../functions/shared/organiser.ts';
import { placeGroup } from '../../functions/shared/placement.ts';
import { transitionProgram } from '../../functions/shared/program-status.ts';
import type { TableKey } from '../../shared/config.ts';
import { HOLDING_STATUSES, OFFER_TTL_MS, type OfferStatus } from '../../shared/offer-lifecycle.ts';
import type { OfferResponse } from '../../shared/offer-input.ts';
import { parseSessionsCsv, programDetailsSchema } from '../../shared/program-input.ts';
import type { SIBLING_MODES } from '../../shared/schema.ts';
import { browserGuest, createCleanup, db, RUN_ID, serverEnv, syntheticProgram } from './helpers/server.ts';

const teamId = serverEnv.organiserTeamId ?? 'organisers';
const cleanup = createCleanup();
const programs: string[] = [];
const key = () => randomUUID().replaceAll('-', '');
const soon = () => Date.now() + 60_000;

const CLEANUP_TABLES: TableKey[] = ['placements', 'waitlist', 'idempotency', 'preferences', 'tickets', 'applications', 'seat_ledger', 'offer_stats', 'audit_log', 'draw_runs'];
afterAll(async () => {
  await Promise.all(
    programs.map(async (programId) => {
      for (const t of CLEANUP_TABLES) await db.deleteRowsWhere(t, [Query.equal('program_id', programId)]).catch(() => undefined);
      await db.deleteRow('programs', programId).catch(() => undefined);
    }),
  );
  await cleanup.run();
}, 600_000);

// ---- scenario builders ----------------------------------------------------------------

let worldCount = 0;
async function world(sessions: [week: string, ageGroup: string, capacity: number][]) {
  const programId = `ito-${String(++worldCount)}-${RUN_ID}`.slice(0, 36);
  programs.push(programId);
  // TEST-ONLY: a program that is already drawn with offers issued.
  await db.createRow('programs', programId, syntheticProgram({ status: 'drawn', org_team_id: teamId, offers_issued_at: new Date().toISOString() }));
  for (const [week, ageGroup, capacity] of sessions) {
    await db.createRow('seat_ledger', ledgerRowId(programId, week, ageGroup), {
      program_id: programId, week, week_start: '2027-06-14T00:00:00.000Z', age_group: ageGroup, min_age: 5, max_age: 12, capacity, taken: 0,
    });
  }
  return programId;
}

interface Fam {
  familyId: string;
  userId: string;
  kids: string[];
}
let famCount = 0;
async function family(programId: string, kids: { requested?: number }[], mode: (typeof SIBLING_MODES)[number] = 'independent'): Promise<Fam> {
  const n = String(++famCount);
  const familyId = `fo-${n}-${RUN_ID}`.slice(0, 36);
  const userId = `uo-${n}-${RUN_ID}`.slice(0, 36);
  await db.createRow('guardians', cleanup.track('guardians', guardianRowId(userId)), { user_id: userId, family_id: familyId, role: 'primary' });
  await db.createRow('applications', applicationRowId(programId, familyId), {
    program_id: programId, family_id: familyId, public_id: newPublicId(), status: 'submitted', sibling_mode: mode, synthetic: true,
  });
  const ids: string[] = [];
  for (const [k, kid] of kids.entries()) {
    const childId = `co-${n}-${String(k)}-${RUN_ID}`.slice(0, 36);
    await db.createRow('preferences', preferenceRowId(programId, childId), {
      program_id: programId, family_id: familyId, child_id: childId, ranked_weeks: ['W1', 'W2'], requested_weeks: kid.requested ?? 1, held_weeks: 0,
    });
    ids.push(childId);
  }
  return { familyId, userId, kids: ids };
}

/** An offer taken through the real seat path; ttl < 0 makes it already expired. */
async function offer(programId: string, f: Fam, week: string, members: [childId: string, ageGroup: string][], ttlMs = OFFER_TTL_MS) {
  const res = await placeGroup(db, {
    programId,
    familyId: f.familyId,
    week,
    members: members.map(([childId, ageGroup]) => ({ childId, ageGroup })),
    idempotencyKey: `test:${programId}:${week}:${members.map((m) => m[0]).join(',')}`,
    permissions: [],
    offerTtlMs: ttlMs,
    source: 'draw',
    stage: async (transactionId) => {
      for (const [childId] of members) {
        await db.incrementRowColumn('preferences', preferenceRowId(programId, childId), 'held_weeks', { value: 1, max: 12, transactionId });
      }
    },
  });
  if (res.status !== 'placed') throw new Error(`setup offer not placed: ${res.status}`);
  return res.placementIds;
}

async function wait(programId: string, f: Fam, childId: string, week: string, ageGroup: string, position: number, rank: number) {
  const row = await db.createRow('waitlist', ID.unique(), { program_id: programId, week, age_group: ageGroup, family_id: f.familyId, child_id: childId, position, rank, status: 'waiting' });
  return row.$id;
}

const respond = (programId: string, f: Fam, placementIds: string[], response: OfferResponse, idempotencyKey = key()) =>
  respondToOffers(db, f.userId, { programId, placementIds, response, idempotencyKey });

/** Settles and classifies concurrent calls. */
async function settle(calls: (() => Promise<unknown>)[]) {
  const results = await Promise.allSettled(calls.map((c) => c()));
  return {
    ok: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value as { status?: string; offers?: { status: string }[] }] : [])),
    errors: results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : [])),
  };
}

const ledger = (programId: string, week: string, ageGroup: string) => db.getRow('seat_ledger', ledgerRowId(programId, week, ageGroup));
const placementsOf = async (programId: string) => (await db.listRows('placements', [Query.equal('program_id', programId), Query.limit(500)])).rows;
const statusOf = async (id: string) => (await db.getRow('placements', id)).status;
const waitStatus = async (id: string) => (await db.getRow('waitlist', id)).status;

async function assertInvariants(programId: string) {
  const [ledgers, placements, prefs, waits] = await Promise.all([
    db.listRows('seat_ledger', [Query.equal('program_id', programId), Query.limit(100)]),
    placementsOf(programId),
    db.listRows('preferences', [Query.equal('program_id', programId), Query.limit(500)]),
    db.listRows('waitlist', [Query.equal('program_id', programId), Query.limit(500)]),
  ]);
  const holding = placements.filter((p) => (HOLDING_STATUSES as readonly OfferStatus[]).includes(p.status));
  for (const l of ledgers.rows) {
    expect(l.taken, `${l.week}/${l.age_group} taken`).toBe(holding.filter((p) => p.ledger_id === l.$id).length);
    expect(l.taken).toBeLessThanOrEqual(l.capacity);
  }
  for (const p of prefs.rows) {
    const n = holding.filter((h) => h.child_id === p.child_id).length;
    expect(p.held_weeks, `held_weeks of ${p.child_id}`).toBe(n);
    expect(n).toBeLessThanOrEqual(p.requested_weeks);
  }
  const placed = new Set(placements.map((p) => `${p.child_id}@${p.week}`));
  expect(placed.size).toBe(placements.length);
  for (const w of waits.rows) {
    expect(w.status === 'promoted', `waitlist ${w.child_id}@${w.week} is ${w.status}`).toBe(placed.has(`${w.child_id}@${w.week}`));
  }
}

// ---- lifecycle ----------------------------------------------------------------------------

describe('offer lifecycle', () => {
  it('sets a server-generated expiry exactly 48 h after issuance', async () => {
    const p = await world([['W1', 'young', 2]]);
    const f = await family(p, [{}]);
    const before = await serverNow(db);
    const [id] = await offer(p, f, 'W1', [[f.kids[0] ?? '', 'young']]);
    const row = await db.getRow('placements', id ?? '');
    const offeredAt = Date.parse(row.offered_at ?? '');
    expect(Date.parse(row.expires_at ?? '') - offeredAt).toBe(OFFER_TTL_MS);
    expect(offeredAt).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(offeredAt).toBeLessThan(before.getTime() + 60_000);
  });

  it('accepts, refuses invalid and repeated transitions, and replays retries', async () => {
    const p = await world([['W1', 'young', 2]]);
    const f = await family(p, [{}]);
    const other = await family(p, [{}]);
    const [id = ''] = await offer(p, f, 'W1', [[f.kids[0] ?? '', 'young']]);

    // Another household cannot see or act on it.
    await expect(respond(p, other, [id], 'accept')).rejects.toMatchObject({ code: 'not_found' });
    // Give back before accepting is not a valid transition.
    await expect(respond(p, f, [id], 'giveBack')).rejects.toMatchObject({ code: 'conflict' });

    const k = key();
    const first = await respond(p, f, [id], 'accept', k);
    expect(first).toMatchObject({ status: 'changed', offers: [{ status: 'accepted' }] });
    expect(await respond(p, f, [id], 'accept', k)).toMatchObject({ status: 'replayed', offers: [{ status: 'accepted' }] });
    expect(await respond(p, f, [id], 'accept')).toMatchObject({ status: 'unchanged' });
    // The same key for a different request is refused.
    await expect(respond(p, f, [id], 'decline', k)).rejects.toMatchObject({ code: 'conflict' });
    await expect(respond(p, f, [id], 'decline')).rejects.toMatchObject({ code: 'conflict' });
    expect((await ledger(p, 'W1', 'young')).taken).toBe(1);

    // Giving the place back releases the seat once.
    expect(await respond(p, f, [id], 'giveBack')).toMatchObject({ status: 'changed', offers: [{ status: 'released' }] });
    expect(await respond(p, f, [id], 'giveBack')).toMatchObject({ status: 'unchanged' });
    expect((await ledger(p, 'W1', 'young')).taken).toBe(0);
    await assertInvariants(p);
  });

  it('cannot be accepted or declined after expiry, even before the sweep records it', async () => {
    const p = await world([['W1', 'young', 1]]);
    const f = await family(p, [{}]);
    const [id = ''] = await offer(p, f, 'W1', [[f.kids[0] ?? '', 'young']], -1000);
    await expect(respond(p, f, [id], 'accept')).rejects.toMatchObject({ code: 'expired' });
    await expect(respond(p, f, [id], 'decline')).rejects.toMatchObject({ code: 'expired' });
    expect(await statusOf(id)).toBe('offered');
    const view = await familyOffers(db, f.userId, p);
    expect(view.programs[0]?.offers[0]).toMatchObject({ status: 'offered', displayStatus: 'lapsed' });

    const swept = await expireDueOffers(db, { deadline: soon(), programId: p });
    expect(swept.expired).toHaveLength(1);
    expect(await statusOf(id)).toBe('expired');
    await expect(respond(p, f, [id], 'accept')).rejects.toMatchObject({ code: 'expired' });
    await assertInvariants(p);
  });

  it('a sweep refuses to expire an offer that has not expired', async () => {
    const p = await world([['W1', 'young', 1]]);
    const f = await family(p, [{}]);
    const [id = ''] = await offer(p, f, 'W1', [[f.kids[0] ?? '', 'young']]);
    await expect(transitionOffers(db, { programId: p, placementIds: [id], to: 'expired', clock: 'after_expiry' })).rejects.toBeInstanceOf(AppError);
    expect(await statusOf(id)).toBe('offered');
  });
});

// ---- acceptance criteria: concurrency ------------------------------------------------

describe('concurrency (acceptance criteria)', () => {
  it('concurrent acceptance of the same offer: one commit, every reply truthful, no seat change', async () => {
    const p = await world([['W1', 'young', 1]]);
    const f = await family(p, [{}]);
    const [id = ''] = await offer(p, f, 'W1', [[f.kids[0] ?? '', 'young']]);
    const shared = key();
    const { ok, errors } = await settle([
      ...Array.from({ length: 4 }, () => () => respond(p, f, [id], 'accept', shared)), // retries of one click
      ...Array.from({ length: 4 }, () => () => respond(p, f, [id], 'accept')), // two guardians, several clicks
    ]);
    expect(errors).toEqual([]);
    expect(ok.filter((r) => r.status === 'changed')).toHaveLength(1);
    for (const r of ok) expect(r.offers?.[0]?.status).toBe('accepted');
    expect(await statusOf(id)).toBe('accepted');
    expect((await ledger(p, 'W1', 'young')).taken).toBe(1);
    await assertInvariants(p);
  });

  it('accept racing decline on one offer: exactly one wins and the seat is released at most once', async () => {
    const p = await world([['W1', 'young', 1]]);
    const f = await family(p, [{}]);
    const [id = ''] = await offer(p, f, 'W1', [[f.kids[0] ?? '', 'young']]);
    const { ok } = await settle([() => respond(p, f, [id], 'accept'), () => respond(p, f, [id], 'decline'), () => respond(p, f, [id], 'accept'), () => respond(p, f, [id], 'decline')]);
    expect(ok.filter((r) => r.status === 'changed')).toHaveLength(1);
    const final = await statusOf(id);
    expect(['accepted', 'declined']).toContain(final);
    expect((await ledger(p, 'W1', 'young')).taken).toBe(final === 'accepted' ? 1 : 0);
    await assertInvariants(p);
  });

  it('two families competing for the final seat: exactly one gets it', async () => {
    const p = await world([['W1', 'young', 2]]);
    const holder = await family(p, [{}]);
    await offer(p, holder, 'W1', [[holder.kids[0] ?? '', 'young']]);
    const a = await family(p, [{}]);
    const b = await family(p, [{}]);
    const attempt = (f: Fam) => () =>
      placeGroup(db, { programId: p, familyId: f.familyId, week: 'W1', members: [{ childId: f.kids[0] ?? '', ageGroup: 'young' }], idempotencyKey: key(), permissions: [], offerTtlMs: OFFER_TTL_MS });
    const { ok, errors } = await settle([attempt(a), attempt(b), attempt(a), attempt(b)]);
    expect(errors).toEqual([]);
    expect(ok.filter((r) => r.status === 'placed')).toHaveLength(1);
    const l = await ledger(p, 'W1', 'young');
    expect(l.taken).toBe(2);
    expect((await placementsOf(p)).length).toBe(2);
  });

  it('two waitlisted families and one freed seat, with duplicate promotion jobs: the earlier family gets it', async () => {
    const p = await world([['W1', 'young', 1]]);
    const holder = await family(p, [{}]);
    const [held = ''] = await offer(p, holder, 'W1', [[holder.kids[0] ?? '', 'young']]);
    const a = await family(p, [{}]);
    const b = await family(p, [{}]);
    const wb = await wait(p, b, b.kids[0] ?? '', 'W1', 'young', 2, 9);
    const wa = await wait(p, a, a.kids[0] ?? '', 'W1', 'young', 1, 4);

    await respond(p, holder, [held], 'decline'); // also promotes inline
    await settle(Array.from({ length: 4 }, () => () => promoteWaitlist(db, p, { deadline: soon() })));
    expect(await waitStatus(wa)).toBe('promoted');
    expect(await waitStatus(wb)).toBe('waiting');
    const offers = (await placementsOf(p)).filter((x) => x.status === 'offered');
    expect(offers.map((x) => x.family_id)).toEqual([a.familyId]);
    expect(offers[0]).toMatchObject({ source: 'waitlist' });
    await assertInvariants(p);
  });

  it('simultaneous expiry processing releases each seat exactly once', async () => {
    const p = await world([['W1', 'young', 6]]);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const f = await family(p, [{}]);
      ids.push(...(await offer(p, f, 'W1', [[f.kids[0] ?? '', 'young']], -1000)));
    }
    expect((await ledger(p, 'W1', 'young')).taken).toBe(6);
    const { ok, errors } = await settle([
      ...Array.from({ length: 3 }, () => () => expireDueOffers(db, { deadline: soon(), programId: p })),
      ...Array.from({ length: 2 }, () => () => runOfferSweep(db, { deadline: soon(), programId: p })),
    ]);
    expect(errors).toEqual([]);
    expect(ok.length).toBe(5);
    for (const id of ids) {
      expect(await statusOf(id)).toBe('expired');
      expect((await db.getRow('idempotency', seatReleaseMarkerId(id))).result).toBe('expired');
      expect((await db.getRow('idempotency', offerExitMarkerId(id, 'offered'))).result).toBe('expired');
    }
    expect((await ledger(p, 'W1', 'young')).taken).toBe(0);
    await assertInvariants(p);
  });

  it('accept racing expiry at the deadline: one outcome, consistent seats', async () => {
    const p = await world([['W1', 'young', 1]]);
    const f = await family(p, [{}]);
    const [id = ''] = await offer(p, f, 'W1', [[f.kids[0] ?? '', 'young']], 1500);
    await new Promise((r) => setTimeout(r, 1200));
    await settle([
      () => respond(p, f, [id], 'accept'),
      () => new Promise((r) => setTimeout(r, 300)).then(() => expireDueOffers(db, { deadline: soon(), programId: p })),
      () => new Promise((r) => setTimeout(r, 600)).then(() => respond(p, f, [id], 'accept')),
      () => new Promise((r) => setTimeout(r, 900)).then(() => expireDueOffers(db, { deadline: soon(), programId: p })),
    ]);
    await expireDueOffers(db, { deadline: soon(), programId: p });
    const final = await statusOf(id);
    expect(['accepted', 'expired']).toContain(final);
    expect((await ledger(p, 'W1', 'young')).taken).toBe(final === 'accepted' ? 1 : 0);
    await assertInvariants(p);
  });

  it('duplicate promotion jobs over a contested week never over-allocate and keep strict order', async () => {
    const p = await world([['W1', 'young', 3], ['W1', 'old', 2]]);
    // Fill every seat with offers that have already expired.
    for (const g of ['young', 'young', 'young', 'old', 'old']) {
      const f = await family(p, [{}]);
      await offer(p, f, 'W1', [[f.kids[0] ?? '', g]], -1000);
    }
    // Waitlist, lottery order by rank: a single (young), siblings together_only (young+old),
    // a single (old), siblings together_preferred (young+young), a single (young).
    const s1 = await family(p, [{}]);
    const sib = await family(p, [{}, {}], 'together_only');
    const s2 = await family(p, [{}]);
    const pref = await family(p, [{}, {}], 'together_preferred');
    const s3 = await family(p, [{}]);
    const entries = {
      s1: await wait(p, s1, s1.kids[0] ?? '', 'W1', 'young', 1, 1),
      sibYoung: await wait(p, sib, sib.kids[0] ?? '', 'W1', 'young', 2, 2),
      sibOld: await wait(p, sib, sib.kids[1] ?? '', 'W1', 'old', 1, 2),
      s2: await wait(p, s2, s2.kids[0] ?? '', 'W1', 'old', 2, 3),
      prefA: await wait(p, pref, pref.kids[0] ?? '', 'W1', 'young', 3, 4),
      prefB: await wait(p, pref, pref.kids[1] ?? '', 'W1', 'young', 4, 4),
      s3: await wait(p, s3, s3.kids[0] ?? '', 'W1', 'young', 5, 5),
    };
    const { errors } = await settle(Array.from({ length: 5 }, () => () => runOfferSweep(db, { deadline: soon(), programId: p })));
    expect(errors).toEqual([]);
    // young (3 seats): s1, sib's young child, then pref can only fit one child (preferred -> alone).
    // old (2 seats): sib's old child, s2.
    const statuses = Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([k, id]) => [k, await waitStatus(id)] as const)));
    expect(statuses).toEqual({ s1: 'promoted', sibYoung: 'promoted', sibOld: 'promoted', s2: 'promoted', prefA: 'promoted', prefB: 'waiting', s3: 'waiting' });
    expect((await ledger(p, 'W1', 'young')).taken).toBe(3);
    expect((await ledger(p, 'W1', 'old')).taken).toBe(2);
    await assertInvariants(p);
  });

  it('together_only siblings are skipped, not split, when only one of their age groups has room', async () => {
    const p = await world([['W1', 'young', 1], ['W1', 'old', 1]]);
    const holder = await family(p, [{}]);
    await offer(p, holder, 'W1', [[holder.kids[0] ?? '', 'old']]);
    const sib = await family(p, [{}, {}], 'together_only');
    const single = await family(p, [{}]);
    const sy = await wait(p, sib, sib.kids[0] ?? '', 'W1', 'young', 1, 1);
    const so = await wait(p, sib, sib.kids[1] ?? '', 'W1', 'old', 1, 1);
    const sw = await wait(p, single, single.kids[0] ?? '', 'W1', 'young', 2, 2);
    await promoteWaitlist(db, p, { deadline: soon() });
    expect([await waitStatus(sy), await waitStatus(so), await waitStatus(sw)]).toEqual(['waiting', 'waiting', 'promoted']);
    await assertInvariants(p);
  });

  it('a child wanting one week, waitlisted in two weeks with free seats, is promoted into exactly one', async () => {
    const p = await world([['W1', 'young', 1], ['W2', 'young', 1]]);
    const f = await family(p, [{ requested: 1 }]);
    const w1 = await wait(p, f, f.kids[0] ?? '', 'W1', 'young', 1, 1);
    const w2 = await wait(p, f, f.kids[0] ?? '', 'W2', 'young', 1, 1);
    await settle([
      () => promoteWaitlist(db, p, { deadline: soon(), weeks: ['W1'] }),
      () => promoteWaitlist(db, p, { deadline: soon(), weeks: ['W2'] }),
      () => promoteWaitlist(db, p, { deadline: soon(), weeks: ['W2'] }),
      () => promoteWaitlist(db, p, { deadline: soon(), weeks: ['W1'] }),
    ]);
    const states = [await waitStatus(w1), await waitStatus(w2)].sort();
    expect(states).toEqual(['promoted', 'waiting']);
    expect((await db.getRow('preferences', preferenceRowId(p, f.kids[0] ?? ''))).held_weeks).toBe(1);
    await assertInvariants(p);
  });
});

// ---- resilience --------------------------------------------------------------------

describe('recovery after interruption', () => {
  it('a release committed without its promotion (crash) is promoted by the next sweep', async () => {
    const p = await world([['W1', 'young', 1]]);
    const holder = await family(p, [{}]);
    const [held = ''] = await offer(p, holder, 'W1', [[holder.kids[0] ?? '', 'young']]);
    const next = await family(p, [{}]);
    const w = await wait(p, next, next.kids[0] ?? '', 'W1', 'young', 1, 1);
    // Simulated crash: the decline commits, nothing after it runs.
    await transitionOffers(db, { programId: p, placementIds: [held], to: 'declined', clock: 'before_expiry' });
    expect(await waitStatus(w)).toBe('waiting');
    const r = await runOfferSweep(db, { deadline: soon(), programId: p });
    expect(r.promoted).toBe(1);
    expect(await waitStatus(w)).toBe('promoted');
    await assertInvariants(p);
  });

  it('a sweep with no time left stops cleanly and the next one finishes the work', async () => {
    const p = await world([['W1', 'young', 3]]);
    for (let i = 0; i < 3; i++) {
      const f = await family(p, [{}]);
      await offer(p, f, 'W1', [[f.kids[0] ?? '', 'young']], -1000);
    }
    const first = await runOfferSweep(db, { deadline: Date.now() - 1, programId: p });
    expect(first.more).toBe(true);
    expect((await db.getRow('programs', p)).offers_swept_at ?? null).toBeNull();
    const second = await runOfferSweep(db, { deadline: soon(), programId: p });
    expect(second).toMatchObject({ expired: 3, more: false });
    expect((await db.getRow('programs', p)).offers_swept_at).toBeTruthy();
    await assertInvariants(p);
  });

  it('organiser cancellation releases the seat and promotes', async () => {
    const p = await world([['W1', 'young', 1]]);
    const holder = await family(p, [{}]);
    const [held = ''] = await offer(p, holder, 'W1', [[holder.kids[0] ?? '', 'young']]);
    await respond(p, holder, [held], 'accept');
    const next = await family(p, [{}]);
    const w = await wait(p, next, next.kids[0] ?? '', 'W1', 'young', 1, 1);
    const program = await db.getRow('programs', p);
    const k = key();
    const [r1, r2] = await Promise.all([cancelOffers(db, program, 'org-user', [held], k), cancelOffers(db, program, 'org-user', [held], k)]);
    expect([r1.status, r2.status].sort()).toEqual(['changed', 'replayed']);
    expect(await statusOf(held)).toBe('cancelled');
    expect(await waitStatus(w)).toBe('promoted');
    await assertInvariants(p);
  });
});

// ---- views ------------------------------------------------------------------------------

describe('who sees what', () => {
  it('public stats are counts only; organisers see pseudonymous refs; families see their own places', async () => {
    const p = await world([['W1', 'young', 1]]);
    const holder = await family(p, [{}]);
    const [held = ''] = await offer(p, holder, 'W1', [[holder.kids[0] ?? '', 'young']]);
    const waiting = await family(p, [{}]);
    await wait(p, waiting, waiting.kids[0] ?? '', 'W1', 'young', 1, 1);
    await runOfferSweep(db, { deadline: soon(), programId: p });

    const guest = browserGuest();
    const stats = await guest.tablesDB.listRows({ databaseId: serverEnv.databaseId, tableId: 'offer_stats', queries: [Query.equal('program_id', p)] });
    expect(stats.rows).toHaveLength(1);
    expect(stats.rows[0]).toMatchObject({ week: 'W1', age_group: 'young', capacity: 1, taken: 1, pending: 1, accepted: 0, waiting: 1 });
    const keys = Object.keys(stats.rows[0] ?? {}).filter((k) => !k.startsWith('$'));
    expect(keys.sort()).toEqual(['accepted', 'age_group', 'capacity', 'computed_at', 'pending', 'program_id', 'promoted', 'taken', 'waiting', 'week']);
    // Guests cannot read placements or waitlist rows.
    const hidden = await guest.tablesDB.listRows({ databaseId: serverEnv.databaseId, tableId: 'placements', queries: [Query.equal('program_id', p)] });
    expect(hidden.rows).toHaveLength(0);

    const overview = await organiserOffersOverview(db, await db.getRow('programs', p));
    expect(overview.offers[0]).toMatchObject({ placementId: held, ref: ticketRowId(p, holder.kids[0] ?? ''), status: 'offered' });
    expect(overview.offers[0]?.publicId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(overview)).not.toContain(holder.familyId);

    const mine = await familyOffers(db, waiting.userId, p);
    expect(mine.programs[0]?.offers).toEqual([]);
    expect(mine.programs[0]?.waitlist[0]).toMatchObject({ position: 1, ahead: 0, status: 'waiting' });
  });
});

// ---- end to end with the real draw ------------------------------------------------------

describe('after a real draw', () => {
  it('issues draw offers once, ranks the waitlist, and promotes in lottery order after a decline', async () => {
    const programId = `itoe-${RUN_ID}`.slice(0, 36);
    programs.push(programId);
    const now = Date.now();
    await createProgram(
      db,
      teamId,
      programDetailsSchema.parse({ name: `[SYNTHETIC] offers e2e ${RUN_ID}`, timezone: 'UTC', windowOpen: new Date(now - 7200_000).toISOString(), windowClose: new Date(now + 2 * 86400_000).toISOString(), maxWeeks: 2, defaultTier: 1, tierLabels: { '0': 'A', '1': 'B' } }),
      { programId, synthetic: true },
    );
    await replaceSessions(db, teamId, programId, parseSessionsCsv('week,week_start,age_group,min_age,max_age,capacity\nW1,2027-06-21,young,5,7,2\nW2,2027-06-28,young,5,7,1\n').sessions);
    await publishProgram(db, teamId, programId);
    const fams: Fam[] = [];
    for (let i = 0; i < 6; i++) {
      const familyId = `fe-${String(i)}-${RUN_ID}`.slice(0, 36);
      const userId = `ue-${String(i)}-${RUN_ID}`.slice(0, 36);
      const childId = `ce-${String(i)}-${RUN_ID}`.slice(0, 36);
      await db.createRow('guardians', cleanup.track('guardians', guardianRowId(userId)), { user_id: userId, family_id: familyId, role: 'primary' });
      await db.createRow('applications', applicationRowId(programId, familyId), { program_id: programId, family_id: familyId, public_id: newPublicId(), status: 'submitted', claimed_tier: 1, sibling_mode: 'independent', synthetic: true });
      await db.createRow('tickets', ticketRowId(programId, childId), { program_id: programId, child_id: childId, family_id: familyId, child_key: newPublicId() + newPublicId() });
      await db.createRow('preferences', preferenceRowId(programId, childId), { program_id: programId, family_id: familyId, child_id: childId, ranked_weeks: ['W1', 'W2'], ranked_age_groups: ['young', 'young'], requested_weeks: 1 });
      fams.push({ familyId, userId, kids: [childId] });
    }
    await transitionProgram(db, programId, 'frozen');
    const ctx = await buildDrawInputs(db, await db.getRow('programs', programId));
    const runId = ID.unique();
    await startDrawRun(db, { programId, drawRunId: runId, seedHex: 'ab'.repeat(32), drandRound: 1, inputs: ctx.inputs });
    expect((await executeDrawRun(db, runId, ctx)).status).toBe('completed');

    // Before issuance families cannot reply.
    const draw = await placementsOf(programId);
    expect(draw).toHaveLength(3);
    const first = draw[0];
    if (!first) throw new Error('no placement');
    const owner = fams.find((f) => f.familyId === first.family_id);
    if (!owner) throw new Error('no owner');
    await expect(respond(programId, owner, [first.$id], 'decline')).rejects.toMatchObject({ code: 'locked' });

    const [i1, i2] = await Promise.all([issueOffers(db, programId), issueOffers(db, programId)]);
    expect([i1.status, i2.status]).toContain('issued');
    expect((await issueOffers(db, programId)).status).toBe('already_issued');
    const issued = await placementsOf(programId);
    for (const pl of issued) expect(Date.parse(pl.expires_at ?? '') - Date.parse(pl.offered_at ?? '')).toBe(OFFER_TTL_MS);
    await assertInvariants(programId);

    const waits = (await db.listRows('waitlist', [Query.equal('program_id', programId), Query.equal('week', 'W1'), Query.orderAsc('position'), Query.limit(50)])).rows;
    expect(waits.length).toBeGreaterThan(0);
    for (const w of waits) expect(w.rank).toBeGreaterThan(0);
    expect(waits.map((w) => w.rank)).toEqual([...waits.map((w) => w.rank)].sort((a, b) => (a ?? 0) - (b ?? 0)));

    const w1 = issued.find((x) => x.week === 'W1');
    const w1Owner = fams.find((f) => f.familyId === w1?.family_id);
    if (!w1 || !w1Owner) throw new Error('no W1 offer');
    const res = await respond(programId, w1Owner, [w1.$id], 'decline');
    expect(res).toMatchObject({ status: 'changed', promoted: 1 });
    // The first still-eligible waiting child in lottery order got the seat.
    const after = await db.listRows('waitlist', [Query.equal('program_id', programId), Query.equal('week', 'W1'), Query.orderAsc('position'), Query.limit(50)]);
    const promotedEntry = after.rows.find((w) => w.status === 'promoted');
    expect(promotedEntry?.$id).toBe(after.rows[0]?.$id);
    await assertInvariants(programId);

    const audit = await db.listRows('audit_log', [Query.equal('program_id', programId), Query.equal('event', ['offers_issued', 'offers_released']), Query.limit(10)]);
    expect(audit.rows.map((a) => a.event).sort()).toEqual(['offers_issued', 'offers_released']);
    expect(audit.rows.map((a) => a.payload).join('')).not.toContain(w1Owner.familyId);
  });
});
