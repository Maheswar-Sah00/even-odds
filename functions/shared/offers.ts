import { Operator, Query } from 'node-appwrite';
import { canTransitionOffer, HOLDING_STATUSES, OFFER_TTL_MS, refusalMessage, releasesSeat, type OfferStatus } from '../../shared/offer-lifecycle.ts';
import { AppError } from './app-error.ts';
import { preferenceRowId } from './applications.ts';
import { appendAudit } from './audit.ts';
import { deterministicId, sha256Hex } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { publishDrawResult, refreshResultOutcomes } from './draw-result.ts';
import { allRows, findRow, isKind, readFor, ticketRowId } from './household.ts';
import { idempotencyRowId, placeGroup } from './placement.ts';
import { sleepBackoff, type RetryOptions } from './retry.ts';

/**
 * Post-draw offers and waitlist (Task 11). The lifecycle itself is in
 * shared/offer-lifecycle.ts; this module enforces it in TablesDB.
 *
 * Guarantees, and the database mechanism behind each (all verified on Cloud,
 * tests/integration/offer-primitives.test.ts and offers.test.ts):
 *
 * - A seat is taken only by placeGroup(): incrementRowColumn(max = capacity)
 *   staged in a transaction; the cap is checked at commit.
 * - A seat is released only by a transition that, in ONE transaction, moves
 *   the placement out of its state, creates that state's exit marker
 *   (deterministic row ID, so a second exit of the same state fails at
 *   commit with transaction_conflict), creates the placement's seat-release
 *   marker (at most one release per placement, ever), and decrements the
 *   ledger with min = 0. A status read beforehand is only a hint: a write
 *   staged after another transaction committed would NOT conflict on its own
 *   (verified), which is why the markers exist.
 * - Offer validity is decided against the transaction's own $createdAt
 *   (Appwrite server time): accept needs createdAt < expires_at, expire needs
 *   createdAt >= expires_at, and both need the "offered" exit marker, so
 *   exactly one of them can win.
 * - Weeks per child: preferences.held_weeks moves only by capped increment
 *   (max = requested_weeks) / decrement (min = 0) in the same transaction as
 *   the placement change, so concurrent promotions into different weeks
 *   cannot give a child more weeks than requested.
 * - Every job is state-driven (it re-reads what is still pending), so a
 *   sweep that is interrupted, retried or run twice at once resumes or
 *   no-ops; duplicates collapse onto the same markers and idempotency keys.
 */

const EXIT_SCOPE = 'offer-exit';
const RELEASE_SCOPE = 'seat-release';
const REPLY_SCOPE = 'offer-reply';
const ISSUE_SCOPE = 'offers-issued';

export const offerExitMarkerId = (placementId: string, from: OfferStatus) => idempotencyRowId(EXIT_SCOPE, `${placementId}:${from}`);
export const seatReleaseMarkerId = (placementId: string) => idempotencyRowId(RELEASE_SCOPE, placementId);
export const offerStatsRowId = (programId: string, week: string, ageGroup: string) => deterministicId('os', 'offer-stats', programId, week, ageGroup);

/** Appwrite server time, read from a throwaway transaction's $createdAt (never the caller's clock). */
export async function serverNow(db: ServerDb): Promise<Date> {
  const tx = await db.transactions.begin(60);
  await db.transactions.rollback(tx.$id).catch(() => undefined);
  return new Date(tx.$createdAt);
}

const markerRow = (scope: string, programId: string, key: string, result?: string) => ({
  scope,
  program_id: programId,
  key_hash: sha256Hex(key),
  ...(result === undefined ? {} : { result }),
});

// ---- transitions ---------------------------------------------------------------

export interface TransitionInput {
  programId: string;
  placementIds: readonly string[];
  to: OfferStatus;
  /** Validity decided against the transaction's own server time. */
  clock?: 'before_expiry' | 'after_expiry';
  /** Client retry key. `fingerprint` binds it to one request: reusing it for another is refused. */
  idempotency?: { key: string; fingerprint: string };
  /** Ownership/role check against the freshly read rows; throws AppError. */
  authorize?: (rows: Row<'placements'>[]) => void;
}

export interface TransitionResult {
  /** changed: this call committed it. replayed: an earlier call with the same key did. unchanged: already in that state. */
  status: 'changed' | 'replayed' | 'unchanged';
  placements: Row<'placements'>[];
  /** Server time the committing transaction began (changed only). */
  at?: string;
  attempts: number;
}

export async function transitionOffers(db: ServerDb, input: TransitionInput, retry: RetryOptions = {}): Promise<TransitionResult> {
  const ids = [...new Set(input.placementIds)];
  if (ids.length === 0) throw new AppError('validation', 'Choose at least one offer.');
  const maxAttempts = retry.maxAttempts ?? 6;
  const idemId = input.idempotency ? idempotencyRowId(REPLY_SCOPE, input.idempotency.key) : null;
  const readRows = async () => {
    const rows = await Promise.all(ids.map((id) => findRow(db, 'placements', id)));
    if (rows.some((r) => !r || r.program_id !== input.programId)) throw new AppError('not_found', 'Offer not found.');
    return rows as Row<'placements'>[];
  };

  for (let attempt = 1; ; attempt++) {
    if (idemId && input.idempotency) {
      const earlier = await findRow(db, 'idempotency', idemId);
      if (earlier) {
        const stored = JSON.parse(earlier.result ?? '{}') as { fingerprint?: string };
        if (stored.fingerprint !== input.idempotency.fingerprint) throw new AppError('conflict', 'This request key was already used for a different request.');
        const rows = await readRows();
        input.authorize?.(rows);
        return { status: 'replayed', placements: rows, attempts: attempt };
      }
    }

    const rows = await readRows();
    input.authorize?.(rows);
    const pending = rows.filter((r) => r.status !== input.to);
    if (pending.length === 0) return { status: 'unchanged', placements: rows, attempts: attempt };
    for (const r of pending) {
      if (!canTransitionOffer(r.status, input.to)) throw new AppError(r.status === 'expired' ? 'expired' : 'conflict', refusalMessage(r.status, input.to));
    }

    const tx = await db.transactions.begin(60);
    const at = Date.parse(tx.$createdAt);
    try {
      for (const r of pending) {
        const expires = r.expires_at ? Date.parse(r.expires_at) : Number.NaN;
        if (input.clock === 'before_expiry' && r.status === 'offered' && !(at < expires)) {
          throw new AppError('expired', 'This offer has expired, so it can no longer be accepted or declined.');
        }
        if (input.clock === 'after_expiry' && !(at >= expires)) throw new AppError('conflict', 'This offer has not expired yet.');
        await db.updateRow('placements', r.$id, { status: input.to, responded_at: Operator.dateSetNow() }, { transactionId: tx.$id });
        await db.createRow('idempotency', offerExitMarkerId(r.$id, r.status), markerRow(EXIT_SCOPE, r.program_id, `${r.$id}:${r.status}`, input.to), { transactionId: tx.$id });
        if (releasesSeat(input.to)) {
          await db.createRow('idempotency', seatReleaseMarkerId(r.$id), markerRow(RELEASE_SCOPE, r.program_id, r.$id, input.to), { transactionId: tx.$id });
          await db.decrementRowColumn('seat_ledger', r.ledger_id, 'taken', { value: 1, min: 0, transactionId: tx.$id });
          await db.decrementRowColumn('preferences', preferenceRowId(r.program_id, r.child_id), 'held_weeks', { value: 1, min: 0, transactionId: tx.$id });
        }
      }
      if (idemId && input.idempotency) {
        const result = JSON.stringify({ fingerprint: input.idempotency.fingerprint, to: input.to, placementIds: ids, at: tx.$createdAt });
        await db.createRow('idempotency', idemId, markerRow(REPLY_SCOPE, input.programId, input.idempotency.key, result), { transactionId: tx.$id });
      }
    } catch (stagingError) {
      await db.transactions.rollback(tx.$id).catch(() => undefined);
      throw stagingError;
    }

    try {
      await db.transactions.commit(tx.$id);
    } catch (err) {
      // Another writer changed one of these offers (or replayed this key). Re-read: the next
      // iteration reports what is committed now, or retries a genuine optimistic conflict.
      if (isKind(err, 'transaction_conflict') && attempt < maxAttempts) {
        await sleepBackoff(attempt, retry);
        continue;
      }
      if (isKind(err, 'capacity_exceeded')) throw new Error(`INVARIANT VIOLATED: releasing ${ids.join(',')} would take a counter below zero`, { cause: err });
      throw err;
    }
    // Staged values are mocks: report the committed rows.
    return { status: 'changed', placements: await readRows(), at: tx.$createdAt, attempts: attempt };
  }
}

// ---- issuing draw offers -------------------------------------------------------

/**
 * Starts the 48 h clock for every draw offer of a drawn program, once:
 * 1. preferences.held_weeks = committed offered/accepted placements per child
 *    (nothing can change them before step 3 opens replies);
 * 2. offered_at/expires_at on draw offers that have none (conditional bulk
 *    update, so a rerun never moves an existing clock);
 * 3. programs.offers_issued_at, which opens replies and sweeps.
 * Safe to rerun after an interruption at any step.
 */
export async function issueOffers(db: ServerDb, programId: string): Promise<{ status: 'issued' | 'already_issued' | 'not_drawn'; offers?: number; expiresAt?: string }> {
  const program = await db.getRow('programs', programId);
  if (program.offers_issued_at) return { status: 'already_issued' };
  if (program.status !== 'drawn') return { status: 'not_drawn' };
  const issuedAt = await serverNow(db);
  const expiresAt = new Date(issuedAt.getTime() + OFFER_TTL_MS).toISOString();

  const [holding, prefs] = await Promise.all([
    allRows(db, 'placements', [Query.equal('program_id', programId), Query.equal('status', [...HOLDING_STATUSES])]),
    allRows(db, 'preferences', [Query.equal('program_id', programId)]),
  ]);
  const held = new Map<string, number>();
  for (const p of holding) held.set(p.child_id, (held.get(p.child_id) ?? 0) + 1);
  const byCount = new Map<number, string[]>();
  for (const p of prefs) {
    const n = held.get(p.child_id) ?? 0;
    byCount.set(n, [...(byCount.get(n) ?? []), p.child_id]);
  }
  for (const [n, childIds] of byCount) {
    for (let i = 0; i < childIds.length; i += 100) {
      await db.updateRowsWhere('preferences', { held_weeks: n }, [Query.equal('program_id', programId), Query.equal('child_id', childIds.slice(i, i + 100))]);
    }
  }

  let offers = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const res = await db.updateRowsWhere('placements', { offered_at: issuedAt.toISOString(), expires_at: expiresAt, source: 'draw' }, [
      Query.equal('program_id', programId),
      Query.equal('status', 'offered'),
      Query.isNull('expires_at'),
    ]);
    if (res.rows.length === 0) break;
    offers += res.rows.length;
  }
  // Opening replies happens once: the flag commits with a one-time marker, so a duplicate run loses.
  const tx = await db.transactions.begin(60);
  try {
    await db.updateRow('programs', programId, { offers_issued_at: issuedAt.toISOString() }, { transactionId: tx.$id });
    await db.createRow('idempotency', idempotencyRowId(ISSUE_SCOPE, programId), markerRow(ISSUE_SCOPE, programId, programId, expiresAt), { transactionId: tx.$id });
  } catch (err) {
    await db.transactions.rollback(tx.$id).catch(() => undefined);
    throw err;
  }
  try {
    await db.transactions.commit(tx.$id);
  } catch (err) {
    if (isKind(err, 'transaction_conflict')) return { status: 'already_issued' };
    throw err;
  }
  await appendAudit(db, { programId, event: 'offers_issued', payload: { offers: holding.filter((p) => p.status === 'offered').length, issued_at: issuedAt.toISOString(), expires_at: expiresAt } }).catch(() => undefined);
  return { status: 'issued', offers, expiresAt };
}

// ---- expiry ----------------------------------------------------------------------

export interface SeatChange {
  programId: string;
  ref: string;
  week: string;
  ageGroup: string;
}

export const toChange = (p: Row<'placements'>): SeatChange => ({ programId: p.program_id, ref: ticketRowId(p.program_id, p.child_id), week: p.week, ageGroup: p.age_group });

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Expires pending offers whose expiry has passed, oldest first, in pages.
 * Each offer is its own transaction (see transitionOffers), so a duplicate
 * sweep running at the same time expires each offer exactly once and the
 * other sees "unchanged". Stops at `deadline`; the rest is picked up next run.
 */
export async function expireDueOffers(db: ServerDb, opts: { deadline: number; programId?: string; concurrency?: number }) {
  const now = await serverNow(db);
  const expired: SeatChange[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (;;) {
    if (Date.now() > opts.deadline) return { expired, skipped, more: true };
    const { rows } = await db.listRows('placements', [
      Query.equal('status', 'offered'),
      Query.lessThanEqual('expires_at', now.toISOString()),
      ...(opts.programId ? [Query.equal('program_id', opts.programId)] : []),
      Query.orderAsc('expires_at'),
      Query.limit(25),
    ]);
    const fresh = rows.filter((r) => !seen.has(r.$id));
    if (fresh.length === 0) return { expired, skipped, more: false };
    const page = { stopped: false };
    await mapLimit(fresh, opts.concurrency ?? 4, async (r) => {
      // Honour the deadline per offer, not only per page: one page can take longer than the budget.
      if (Date.now() > opts.deadline) {
        page.stopped = true;
        return;
      }
      seen.add(r.$id);
      try {
        const res = await transitionOffers(db, { programId: r.program_id, placementIds: [r.$id], to: 'expired', clock: 'after_expiry' });
        if (res.status === 'changed') expired.push(toChange(r));
      } catch (err) {
        // Accepted, declined or cancelled in the meantime: the database refused the release.
        if (err instanceof AppError) skipped++;
        else throw err;
      }
    });
    if (page.stopped) return { expired, skipped, more: true };
  }
}

// ---- promotion -------------------------------------------------------------------

export interface Promotion extends SeatChange {
  position: number;
  placementId: string;
}

const promotionKey = (programId: string, week: string, childIds: string[]) => `promote:${programId}:${week}:${[...childIds].sort().join(',')}`;

async function familyPermissions(db: ServerDb, familyId: string, teamId: string) {
  const guardians = await allRows(db, 'guardians', [Query.equal('family_id', familyId)]);
  return readFor(guardians.map((g) => g.user_id), [teamId]);
}

async function rowsIn<K extends 'applications' | 'preferences' | 'placements'>(db: ServerDb, table: K, base: string[], column: string, values: string[]) {
  const out: Row<K>[] = [];
  const unique = [...new Set(values)];
  for (let i = 0; i < unique.length; i += 100) out.push(...(await allRows(db, table, [...base, Query.equal(column, unique.slice(i, i + 100))])));
  return out;
}

/**
 * One pass over a week: families in strict lottery order (waitlist.rank, the
 * draw's order; position within an age group breaks ties), each taking free
 * seats only in their own age groups:
 * - together_only: every eligible waiting sibling at once, or none;
 * - together_preferred: all together if possible, otherwise one by one;
 * - independent / single child: one by one.
 * A child is eligible while its application is submitted and held_weeks <
 * requested_weeks. Free-seat counts read here only decide whether an attempt
 * is worth making; whether a seat exists is decided by the capped increment
 * at commit. Returns `restart` when a re-read shows seats freed mid-pass, so
 * the caller starts again from the top of the order (strictness).
 */
async function promoteWeekPass(db: ServerDb, program: Row<'programs'>, week: string, deadline: number) {
  const promoted: Promotion[] = [];
  const base = [Query.equal('program_id', program.$id)];
  const loadFree = async () => {
    const ledgers = await allRows(db, 'seat_ledger', [...base, Query.equal('week', week)]);
    return new Map(ledgers.map((l) => [l.age_group, l.capacity - l.taken]));
  };
  let free = await loadFree();
  if (![...free.values()].some((n) => n > 0)) return { promoted, restart: false, more: false };

  const entries = await allRows(db, 'waitlist', [...base, Query.equal('week', week), Query.equal('status', 'waiting')]);
  if (entries.length === 0) return { promoted, restart: false, more: false };
  const childIds = entries.map((e) => e.child_id);
  const [apps, prefs, existing] = await Promise.all([
    rowsIn(db, 'applications', base, 'family_id', entries.map((e) => e.family_id)),
    rowsIn(db, 'preferences', base, 'child_id', childIds),
    rowsIn(db, 'placements', [...base, Query.equal('week', week)], 'child_id', childIds),
  ]);
  const appOf = new Map(apps.map((a) => [a.family_id, a]));
  const prefOf = new Map(prefs.map((p) => [p.child_id, p]));
  const placedChildren = new Set(existing.map((p) => p.child_id));

  const order = (e: Row<'waitlist'>) => [e.rank ?? Number.MAX_SAFE_INTEGER, e.position] as const;
  const families = new Map<string, Row<'waitlist'>[]>();
  for (const e of [...entries].sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1] || a.age_group.localeCompare(b.age_group))) {
    families.set(e.family_id, [...(families.get(e.family_id) ?? []), e]);
  }

  for (const [familyId, mine] of families) {
    if (Date.now() > deadline) return { promoted, restart: false, more: true };
    const app = appOf.get(familyId);
    const eligible: Row<'waitlist'>[] = [];
    for (const e of mine) {
      if (placedChildren.has(e.child_id)) {
        // Placed for this week already (e.g. a crash after commit, before this row was updated): repair.
        await db.updateRow('waitlist', e.$id, { status: 'promoted' }).catch(() => undefined);
        continue;
      }
      const pref = prefOf.get(e.child_id);
      if (app?.status !== 'submitted' || !pref || (pref.held_weeks ?? 0) >= pref.requested_weeks) continue;
      eligible.push(e);
    }
    if (eligible.length === 0) continue;

    const mode = eligible.length > 1 ? app?.sibling_mode : 'independent';
    const attempts =
      mode === 'together_only' ? [eligible] : mode === 'together_preferred' ? [eligible, ...eligible.map((e) => [e])] : eligible.map((e) => [e]);
    const done = new Set<string>();
    for (const group of attempts) {
      if (group.some((e) => done.has(e.child_id))) continue;
      const need = new Map<string, number>();
      for (const e of group) need.set(e.age_group, (need.get(e.age_group) ?? 0) + 1);
      if ([...need].some(([g, n]) => (free.get(g) ?? 0) < n)) continue;

      const members = group.map((e) => ({ childId: e.child_id, ageGroup: e.age_group }));
      const result = await placeGroup(db, {
        programId: program.$id,
        familyId,
        week,
        members,
        idempotencyKey: promotionKey(program.$id, week, members.map((m) => m.childId)),
        permissions: await familyPermissions(db, familyId, program.org_team_id),
        offerTtlMs: OFFER_TTL_MS,
        source: 'waitlist',
        stage: async (transactionId) => {
          for (const e of group) {
            const pref = prefOf.get(e.child_id);
            if (!pref) throw new Error('unreachable');
            await db.incrementRowColumn('preferences', pref.$id, 'held_weeks', { value: 1, max: pref.requested_weeks, transactionId });
            await db.updateRow('waitlist', e.$id, { status: 'promoted' }, { transactionId });
          }
        },
      });
      if (result.status === 'placed') {
        for (const [i, e] of group.entries()) {
          done.add(e.child_id);
          placedChildren.add(e.child_id);
          free.set(e.age_group, (free.get(e.age_group) ?? 0) - 1);
          promoted.push({ programId: program.$id, ref: ticketRowId(program.$id, e.child_id), week, ageGroup: e.age_group, position: e.position, placementId: result.placementIds[i] ?? '' });
        }
        if (mode === 'together_preferred') break;
        continue;
      }
      // replayed / already_placed: a duplicate job got there first. no_capacity: the cap
      // (seats or this child's weeks) refused it. Either way, re-read the seats.
      if (result.status !== 'no_capacity') for (const e of group) done.add(e.child_id);
      const before = free;
      free = await loadFree();
      if ([...free].some(([g, n]) => n > (before.get(g) ?? 0))) return { promoted, restart: true, more: false };
      if (result.status === 'no_capacity') {
        // Refresh this family's held_weeks so a satisfied child is not retried in this pass.
        for (const e of group) {
          const fresh = await findRow(db, 'preferences', preferenceRowId(program.$id, e.child_id));
          if (fresh) prefOf.set(e.child_id, fresh);
        }
      }
    }
    if (![...free.values()].some((n) => n > 0)) break;
  }
  return { promoted, restart: false, more: false };
}

export async function promoteWaitlist(db: ServerDb, programId: string, opts: { deadline: number; weeks?: readonly string[] }) {
  const program = await db.getRow('programs', programId);
  const promoted: Promotion[] = [];
  if (program.status !== 'drawn' || !program.offers_issued_at) return { promoted, more: false };
  const ledgers = await allRows(db, 'seat_ledger', [Query.equal('program_id', programId)]);
  const weeks = [...new Set(ledgers.filter((l) => l.taken < l.capacity && (!opts.weeks || opts.weeks.includes(l.week))).map((l) => l.week))].sort();
  for (const week of weeks) {
    for (let pass = 0; pass < 5; pass++) {
      const r = await promoteWeekPass(db, program, week, opts.deadline);
      promoted.push(...r.promoted);
      if (r.more) return { promoted, more: true };
      if (!r.restart) break;
    }
  }
  return { promoted, more: false };
}

// ---- public aggregates -------------------------------------------------------------

/** Recounts the public per-session aggregates (counts only; no families, children or refs). */
export async function refreshOfferStats(db: ServerDb, programId: string, at?: Date) {
  const computedAt = (at ?? (await serverNow(db))).toISOString();
  const ledgers = await allRows(db, 'seat_ledger', [Query.equal('program_id', programId)]);
  const count = async (table: 'placements' | 'waitlist', week: string, ageGroup: string, status: string) =>
    (await db.listRows(table, [Query.equal('program_id', programId), Query.equal('week', week), Query.equal('age_group', ageGroup), Query.equal('status', status), Query.limit(1)])).total;
  await mapLimit(ledgers, 4, async (l) => {
    const [pending, accepted, waiting, promoted] = await Promise.all([
      count('placements', l.week, l.age_group, 'offered'),
      count('placements', l.week, l.age_group, 'accepted'),
      count('waitlist', l.week, l.age_group, 'waiting'),
      count('waitlist', l.week, l.age_group, 'promoted'),
    ]);
    await db.upsertRow('offer_stats', offerStatsRowId(programId, l.week, l.age_group), {
      program_id: programId, week: l.week, age_group: l.age_group, capacity: l.capacity, taken: l.taken, pending, accepted, waiting, promoted, computed_at: computedAt,
    });
  });
  // Task 13: the published draw result (backstop if the draw step did not publish it) and its live outcomes.
  // Best effort like the counts: a failure here must not stop the sweep for other programs; the next sweep retries.
  await publishDrawResult(db, programId)
    .then(() => refreshResultOutcomes(db, programId, new Date(computedAt)))
    .catch(() => undefined);
  return ledgers.length;
}

async function auditChanges(db: ServerDb, programId: string, event: string, released: SeatChange[], promoted: Promotion[], extra: Record<string, unknown> = {}) {
  if (released.length === 0 && promoted.length === 0) return;
  const payload = {
    ...extra,
    released: released.map((r) => ({ ref: r.ref, week: r.week, age_group: r.ageGroup })),
    promoted: promoted.map((p) => ({ ref: p.ref, week: p.week, age_group: p.ageGroup, position: p.position })),
  };
  // Best effort: the change is already committed and must be reported truthfully even if the log append fails.
  await appendAudit(db, { programId, event, payload }).catch(() => undefined);
}

// ---- the sweep job -------------------------------------------------------------------

/**
 * The scheduled offers step: issue due draw offers, expire lapsed ones,
 * promote from the waitlist, refresh public counts. Bounded by `deadline`
 * (the jobs Function has a 120 s timeout and shares it with the draw);
 * everything is re-derived from committed rows, so the next run resumes.
 */
export async function runOfferSweep(db: ServerDb, opts: { deadline: number; programId?: string }) {
  const programs = opts.programId ? [await db.getRow('programs', opts.programId)] : await allRows(db, 'programs', [Query.equal('status', 'drawn')]);
  const issued: Record<string, unknown> = {};
  for (const p of programs) if (p.status === 'drawn' && !p.offers_issued_at) issued[p.$id] = await issueOffers(db, p.$id);

  const expiry = await expireDueOffers(db, { deadline: opts.deadline, ...(opts.programId ? { programId: opts.programId } : {}) });
  const promoted: Promotion[] = [];
  let more = expiry.more;
  for (const p of programs) {
    if (Date.now() > opts.deadline) {
      more = true;
      break;
    }
    const r = await promoteWaitlist(db, p.$id, { deadline: opts.deadline });
    promoted.push(...r.promoted);
    more ||= r.more;
  }
  const now = await serverNow(db);
  for (const p of programs) {
    const fresh = await db.getRow('programs', p.$id);
    if (!fresh.offers_issued_at) continue;
    await auditChanges(db, p.$id, 'offers_swept', expiry.expired.filter((e) => e.programId === p.$id), promoted.filter((x) => x.programId === p.$id), { reason: 'expired' });
    if (Date.now() < opts.deadline) await refreshOfferStats(db, p.$id, now);
    if (!more) await db.updateRow('programs', p.$id, { offers_swept_at: now.toISOString() });
  }
  return { issued, expired: expiry.expired.length, skipped: expiry.skipped, promoted: promoted.length, more };
}

/** After a family or organiser frees seats: promote in those weeks now (best effort; the sweep is the backstop). */
export async function afterRelease(db: ServerDb, programId: string, released: SeatChange[], event: string, budgetMs = 12_000) {
  if (released.length === 0) return { promoted: [] as Promotion[] };
  const deadline = Date.now() + budgetMs;
  try {
    const { promoted } = await promoteWaitlist(db, programId, { deadline, weeks: [...new Set(released.map((r) => r.week))] });
    await auditChanges(db, programId, event, released, promoted);
    await refreshOfferStats(db, programId).catch(() => undefined);
    return { promoted };
  } catch {
    await auditChanges(db, programId, event, released, []);
    return { promoted: [] as Promotion[] };
  }
}
