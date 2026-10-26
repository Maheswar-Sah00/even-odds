import { Query } from 'node-appwrite';
import { ServiceError } from '../../shared/errors.ts';
import { deterministicId, sha256Hex } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { sleepBackoff, type RetryOptions } from './retry.ts';

/**
 * All-or-nothing placement of a group of children (one family's siblings, or a
 * single child) into one week. Verified on Appwrite Cloud
 * (docs/VERIFIED-BEHAVIOUR.md):
 *
 * - The seat cap is enforced by incrementRowColumn({ max: capacity }) staged in
 *   a transaction. Staging always "succeeds" with mock values; the cap is
 *   checked at COMMIT, which fails with attribute_limit_exceeded and rolls
 *   back every staged operation.
 * - One placement per (child, week) is enforced by the unique index
 *   uq_child_week and by a deterministic row ID. A violation at commit
 *   surfaces as 409 transaction_conflict (NOT row_already_exists), the same
 *   error as a genuine optimistic conflict, so we disambiguate by re-reading.
 * - Idempotency: an idempotency row with a deterministic ID is staged in the
 *   same transaction, so "effect happened" and "key recorded" are atomic.
 */

export interface GroupMember {
  childId: string;
  ageGroup: string;
}

export interface PlaceGroupInput {
  programId: string;
  familyId: string;
  week: string;
  members: readonly GroupMember[];
  /** Caller-supplied key; the same key always yields the same outcome. */
  idempotencyKey: string;
  /** Row permissions for the created placements (see permissions.ts). */
  permissions: string[];
  drawRunId?: string;
  round?: number;
  offerExpiresAt?: string;
  /**
   * Offer clock from the Appwrite server: offered_at = the placing
   * transaction's $createdAt, expires_at = offered_at + offerTtlMs.
   */
  offerTtlMs?: number;
  source?: 'draw' | 'waitlist';
  /** Further writes staged in the SAME transaction (they commit or roll back with the seats). */
  stage?: (transactionId: string) => Promise<void>;
}

export interface LedgerState {
  ledgerId: string;
  ageGroup: string;
  taken: number;
  capacity: number;
}

export type PlaceGroupResult =
  | { status: 'placed'; placementIds: string[]; ledgers: LedgerState[]; attempts: number }
  | { status: 'replayed'; placementIds: string[] }
  | { status: 'no_capacity'; attempts: number }
  | { status: 'already_placed'; childIds: string[] };

export const placementRowId = (programId: string, childId: string, week: string) => deterministicId('pl', 'placement', programId, childId, week);
export const idempotencyRowId = (scope: string, key: string) => deterministicId('ik', scope, key);

const SCOPE = 'place';

async function findRow<K extends Parameters<ServerDb['getRow']>[0]>(db: ServerDb, table: K, rowId: string): Promise<Row<K> | null> {
  try {
    return await db.getRow(table, rowId);
  } catch (err) {
    if (err instanceof ServiceError && err.mapped.kind === 'not_found') return null;
    throw err;
  }
}

async function loadLedgers(db: ServerDb, programId: string, week: string, ageGroups: string[]) {
  const { rows } = await db.listRows('seat_ledger', [
    Query.equal('program_id', programId),
    Query.equal('week', week),
    Query.equal('age_group', ageGroups),
    Query.limit(ageGroups.length),
  ]);
  const byGroup = new Map(rows.map((r) => [r.age_group, r]));
  const missing = ageGroups.filter((g) => !byGroup.has(g));
  if (missing.length > 0) throw new Error(`No seat ledger for week ${week}, age group(s) ${missing.join(', ')}`);
  return byGroup;
}

export async function placeGroup(db: ServerDb, input: PlaceGroupInput, retry: RetryOptions = {}): Promise<PlaceGroupResult> {
  if (input.members.length === 0) throw new Error('placeGroup needs at least one member');
  if (new Set(input.members.map((m) => m.childId)).size !== input.members.length) throw new Error('duplicate child in group');

  const idemId = idempotencyRowId(SCOPE, input.idempotencyKey);
  const placementIds = input.members.map((m) => placementRowId(input.programId, m.childId, input.week));
  const maxAttempts = retry.maxAttempts ?? 5;

  const replay = async (): Promise<PlaceGroupResult | null> => {
    const idem = await findRow(db, 'idempotency', idemId);
    if (!idem) return null;
    const stored = JSON.parse(idem.result ?? '{}') as { placementIds?: string[] };
    return { status: 'replayed', placementIds: stored.placementIds ?? [] };
  };

  const earlier = await replay();
  if (earlier) return earlier;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Capacity is read from the server-side ledger, never from the caller.
    const ageGroups = [...new Set(input.members.map((m) => m.ageGroup))];
    const ledgers = await loadLedgers(db, input.programId, input.week, ageGroups);

    const tx = await db.transactions.begin(60);
    const offeredAt = input.offerTtlMs === undefined ? null : new Date(tx.$createdAt);
    const expiresAt = offeredAt && input.offerTtlMs !== undefined ? new Date(offeredAt.getTime() + input.offerTtlMs).toISOString() : input.offerExpiresAt;
    try {
      for (const group of ageGroups) {
        const ledger = ledgers.get(group);
        if (!ledger) throw new Error('unreachable');
        const seats = input.members.filter((m) => m.ageGroup === group).length;
        await db.incrementRowColumn('seat_ledger', ledger.$id, 'taken', { value: seats, max: ledger.capacity, transactionId: tx.$id });
      }
      for (const [i, member] of input.members.entries()) {
        const ledger = ledgers.get(member.ageGroup);
        if (!ledger) throw new Error('unreachable');
        await db.createRow(
          'placements',
          placementIds[i] ?? '',
          {
            program_id: input.programId,
            child_id: member.childId,
            family_id: input.familyId,
            ledger_id: ledger.$id,
            week: input.week,
            age_group: member.ageGroup,
            status: 'offered',
            ...(expiresAt ? { expires_at: expiresAt } : {}),
            ...(offeredAt ? { offered_at: offeredAt.toISOString() } : {}),
            ...(input.source ? { source: input.source } : {}),
            ...(input.drawRunId ? { draw_run_id: input.drawRunId } : {}),
            ...(input.round ? { round: input.round } : {}),
          },
          { permissions: input.permissions, transactionId: tx.$id },
        );
      }
      await db.createRow(
        'idempotency',
        idemId,
        { scope: SCOPE, program_id: input.programId, key_hash: sha256Hex(input.idempotencyKey), result: JSON.stringify({ placementIds }) },
        { transactionId: tx.$id },
      );
      if (input.stage) await input.stage(tx.$id);
    } catch (stagingError) {
      await db.transactions.rollback(tx.$id).catch(() => undefined);
      throw stagingError;
    }

    try {
      await db.transactions.commit(tx.$id);
    } catch (err) {
      if (!(err instanceof ServiceError)) throw err;
      if (err.mapped.kind === 'capacity_exceeded') {
        // A duplicate of THIS request may have taken the last seat a moment earlier (found by the
        // Task 14 stress suite: overlapping draw workers then saw "no_capacity" and failed the run).
        // Its commit included the idempotency row, so it is visible now.
        const replayed = await replay();
        if (replayed) return replayed;
        return { status: 'no_capacity', attempts: attempt };
      }
      if (err.mapped.kind !== 'transaction_conflict') throw err;

      // A unique violation and an optimistic conflict look identical; re-read to tell them apart.
      const replayed = await replay();
      if (replayed) return replayed;
      const existing = await Promise.all(placementIds.map((id) => findRow(db, 'placements', id)));
      const placedChildren = input.members.filter((_, i) => existing[i] !== null).map((m) => m.childId);
      if (placedChildren.length > 0) return { status: 'already_placed', childIds: placedChildren };
      if (attempt === maxAttempts) throw err;
      await sleepBackoff(attempt, retry);
      continue;
    }

    // Values returned while staging are mocks: re-read the committed counters.
    const after = await loadLedgers(db, input.programId, input.week, ageGroups);
    const states = ageGroups.map((g) => {
      const row = after.get(g);
      if (!row) throw new Error('unreachable');
      return { ledgerId: row.$id, ageGroup: g, taken: row.taken, capacity: row.capacity };
    });
    const oversold = states.find((s) => s.taken > s.capacity);
    if (oversold) throw new Error(`INVARIANT VIOLATED: ledger ${oversold.ledgerId} taken ${oversold.taken} > capacity ${oversold.capacity}`);
    return { status: 'placed', placementIds, ledgers: states, attempts: attempt };
  }
  throw new Error('unreachable');
}
