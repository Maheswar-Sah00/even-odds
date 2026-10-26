/**
 * Task 11 experiment: the TablesDB primitives the offer workflow relies on
 * that docs/VERIFIED-BEHAVIOUR.md did not yet cover. Runs against the REAL
 * Appwrite project in .env.server; nothing is mocked.
 */
import { Operator, Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idempotencyRowId } from '../../functions/shared/placement.ts';
import { sha256Hex } from '../../functions/shared/crypto.ts';
import { ServiceError } from '../../shared/errors.ts';
import { createCleanup, db, newId, RUN_ID, syntheticProgram } from './helpers/server.ts';

const cleanup = createCleanup();
const programId = newId();

beforeAll(async () => {
  cleanup.track('programs', programId);
  await db.createRow('programs', programId, syntheticProgram());
});

afterAll(async () => {
  for (const table of ['placements', 'idempotency', 'seat_ledger'] as const) {
    for (;;) {
      const { rows } = await db.listRows(table, [Query.equal('program_id', programId), Query.limit(100)]);
      if (rows.length === 0) break;
      await Promise.all(rows.map((r) => db.deleteRow(table, r.$id)));
    }
  }
  await cleanup.run();
});

let weekCounter = 0;
async function ledger(capacity: number, taken: number) {
  const week = `P${String(++weekCounter).padStart(2, '0')}`;
  const row = await db.createRow('seat_ledger', newId(), {
    program_id: programId, week, week_start: '2027-06-14T00:00:00.000Z', age_group: '6-8', min_age: 6, max_age: 8, capacity, taken,
  });
  return row.$id;
}
const takenOf = async (ledgerId: string) => (await db.getRow('seat_ledger', ledgerId)).taken;
const capture = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (err) {
    return err as ServiceError;
  }
  throw new Error('expected failure');
};

async function placement(extra: Partial<{ expires_at: string; status: 'offered' | 'accepted' }> = {}) {
  const row = await db.createRow('placements', newId(), {
    program_id: programId, child_id: `c-${newId()}`, family_id: `f-${RUN_ID}`, ledger_id: 'none', week: 'P00', age_group: '6-8', status: 'offered', ...extra,
  });
  return row;
}

describe('capped decrement (decrementRowColumn with min), staged in a transaction', () => {
  it('commits a release above the floor', async () => {
    const id = await ledger(3, 1);
    const tx = await db.transactions.begin(60);
    await db.decrementRowColumn('seat_ledger', id, 'taken', { value: 1, min: 0, transactionId: tx.$id });
    await db.transactions.commit(tx.$id);
    expect(await takenOf(id)).toBe(0);
  });

  it('refuses at commit, and rolls back, when the release would go below the floor', async () => {
    const id = await ledger(3, 0);
    const tx = await db.transactions.begin(60);
    await db.decrementRowColumn('seat_ledger', id, 'taken', { value: 1, min: 0, transactionId: tx.$id });
    const err = await capture(() => db.transactions.commit(tx.$id));
    expect(err.mapped.status).toBe(400);
    expect(err.mapped.kind).toBe('capacity_exceeded');
    expect(await takenOf(id)).toBe(0);
  });

  it('a concurrent capped increment and decrement on one ledger both commit', async () => {
    const id = await ledger(2, 2);
    const [dec, inc] = await Promise.all([db.transactions.begin(60), db.transactions.begin(60)]);
    await db.decrementRowColumn('seat_ledger', id, 'taken', { value: 1, min: 0, transactionId: dec.$id });
    await db.incrementRowColumn('seat_ledger', id, 'taken', { value: 1, max: 2, transactionId: inc.$id });
    await db.transactions.commit(dec.$id);
    await db.transactions.commit(inc.$id);
    expect(await takenOf(id)).toBe(2);
  });
});

describe('server clock', () => {
  it('a transaction carries the Appwrite server time it was created at', async () => {
    const before = Date.now();
    const tx = await db.transactions.begin(60);
    const after = Date.now();
    await db.transactions.rollback(tx.$id);
    const at = Date.parse(tx.$createdAt);
    expect(Number.isNaN(at)).toBe(false);
    // Within 30 s of this machine's clock (the test asserts sanity, not equality).
    expect(Math.abs(at - (before + after) / 2)).toBeLessThan(30_000);
  });

  it('Operator.dateSetNow() in a transaction writes the server time at commit', async () => {
    const row = await placement();
    const tx = await db.transactions.begin(60);
    await db.updateRow('placements', row.$id, { responded_at: Operator.dateSetNow() }, { transactionId: tx.$id });
    await db.transactions.commit(tx.$id);
    const after = await db.getRow('placements', row.$id);
    expect(after.responded_at).toBeTruthy();
    expect(Date.parse(after.responded_at ?? '')).toBeGreaterThanOrEqual(Date.parse(tx.$createdAt) - 1000);
  });
});

describe('conditional bulk update (updateRows with queries)', () => {
  it('only touches rows that match the queries when it runs', async () => {
    const a = await placement();
    const b = await placement({ expires_at: '2030-01-01T00:00:00.000Z' });
    const res = await db.updateRowsWhere('placements', { expires_at: '2031-01-01T00:00:00.000Z' }, [
      Query.equal('program_id', programId),
      Query.equal('week', 'P00'),
      Query.isNull('expires_at'),
    ]);
    expect(res.rows.map((r) => r.$id)).toContain(a.$id);
    expect(res.rows.map((r) => r.$id)).not.toContain(b.$id);
    expect((await db.getRow('placements', b.$id)).expires_at).toMatch(/^2030-01-01/);
  });
});

describe('why a read-then-write status check is not enough', () => {
  it('an update staged AFTER another transaction committed is not a conflict (stale read wins)', async () => {
    const row = await placement();
    const seen = (await db.getRow('placements', row.$id)).status; // both writers read "offered"
    const first = await db.transactions.begin(60);
    await db.updateRow('placements', row.$id, { status: 'accepted' }, { transactionId: first.$id });
    await db.transactions.commit(first.$id);
    expect(seen).toBe('offered');
    const second = await db.transactions.begin(60);
    await db.updateRow('placements', row.$id, { status: 'expired' }, { transactionId: second.$id });
    await db.transactions.commit(second.$id); // commits: the accepted offer was overwritten
    expect((await db.getRow('placements', row.$id)).status).toBe('expired');
  });

  it('a deterministic transition marker turns the second writer into a conflict', async () => {
    const row = await placement();
    const markerId = idempotencyRowId('offer-exit', `${row.$id}:offered`);
    const marker = { scope: 'offer-exit', program_id: programId, key_hash: sha256Hex(`${row.$id}:offered`) };
    const first = await db.transactions.begin(60);
    await db.updateRow('placements', row.$id, { status: 'accepted' }, { transactionId: first.$id });
    await db.createRow('idempotency', markerId, marker, { transactionId: first.$id });
    await db.transactions.commit(first.$id);
    const second = await db.transactions.begin(60);
    await db.updateRow('placements', row.$id, { status: 'expired' }, { transactionId: second.$id });
    await db.createRow('idempotency', markerId, marker, { transactionId: second.$id });
    const err = await capture(() => db.transactions.commit(second.$id));
    expect(err.mapped.kind).toBe('transaction_conflict');
    expect((await db.getRow('placements', row.$id)).status).toBe('accepted');
  });
});
