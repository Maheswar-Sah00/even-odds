/**
 * CRITICAL EXPERIMENT + invariant suite. Runs against the REAL Appwrite
 * project in .env.server. No transaction, counter or index is mocked.
 * Results are recorded in docs/VERIFIED-BEHAVIOUR.md.
 */
import { ID, Operator, Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, verifyChain } from '../../functions/shared/audit.ts';
import { placeGroup, placementRowId } from '../../functions/shared/placement.ts';
import { ServiceError } from '../../shared/errors.ts';
import { aw, createCleanup, db, newId, RUN_ID, serverEnv, syntheticProgram } from './helpers/server.ts';

const cleanup = createCleanup();
const programId = newId();
const perms: string[] = []; // server-only rows for these tests; permission behaviour is covered in permissions.test.ts

beforeAll(async () => {
  cleanup.track('programs', programId);
  await db.createRow('programs', programId, syntheticProgram());
});

afterAll(async () => {
  // Rows created inside committed transactions are found by program_id.
  for (const table of ['placements', 'idempotency', 'audit_log', 'seat_ledger'] as const) {
    for (;;) {
      const { rows } = await db.listRows(table, [Query.equal('program_id', programId), Query.limit(100)]);
      if (rows.length === 0) break;
      await Promise.all(rows.map((r) => db.deleteRow(table, r.$id)));
    }
  }
  await cleanup.run();
});

let weekCounter = 0;
async function ledger(capacity: number, taken = 0, ageGroup = '6-8') {
  const week = `W${String(++weekCounter).padStart(2, '0')}`;
  const row = await db.createRow('seat_ledger', newId(), {
    program_id: programId,
    week,
    week_start: '2027-06-14T00:00:00.000Z',
    age_group: ageGroup,
    min_age: 6,
    max_age: 8,
    capacity,
    taken,
  });
  return { ledgerId: row.$id, week, ageGroup };
}

const takenOf = async (ledgerId: string) => (await db.getRow('seat_ledger', ledgerId)).taken;
const placementsIn = async (week: string) =>
  (await db.listRows('placements', [Query.equal('program_id', programId), Query.equal('week', week), Query.limit(100)])).total;
const capture = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (err) {
    return err as ServiceError;
  }
  throw new Error('expected failure');
};
const child = (n: string) => `ch-${n}-${RUN_ID}`.slice(0, 36);

describe('A–F: capped counter (dedicated incrementRowColumn endpoint)', () => {
  it('direct increment throws column_limit_exceeded at the cap and leaves the counter intact', async () => {
    const { ledgerId } = await ledger(1, 0);
    await db.incrementRowColumn('seat_ledger', ledgerId, 'taken', { value: 1, max: 1 });
    const err = await capture(() => db.incrementRowColumn('seat_ledger', ledgerId, 'taken', { value: 1, max: 1 }));
    expect(err.mapped).toMatchObject({ kind: 'capacity_exceeded', status: 400, type: 'column_limit_exceeded' });
    expect(await takenOf(ledgerId)).toBe(1);
  });

  it('CONTRAST: generic Operator.increment(max) silently no-ops at the cap (why we never use it)', async () => {
    const { ledgerId } = await ledger(1, 1);
    const row = await aw.tablesDB.updateRow({
      databaseId: serverEnv.databaseId,
      tableId: 'seat_ledger',
      rowId: ledgerId,
      data: { taken: Operator.increment(1, 1) },
    });
    expect(row.taken).toBe(1); // no error, no change: a sold-out seat would look "booked"
  });

  it('staged in a transaction: staging returns mock values, commit throws attribute_limit_exceeded and rolls back', async () => {
    const { ledgerId } = await ledger(1, 1);
    const tx = await db.transactions.begin(60);
    await db.incrementRowColumn('seat_ledger', ledgerId, 'taken', { value: 1, max: 1, transactionId: tx.$id }); // does not throw
    const err = await capture(() => db.transactions.commit(tx.$id));
    expect(err.mapped).toMatchObject({ kind: 'capacity_exceeded', type: 'attribute_limit_exceeded' });
    expect((await db.transactions.get(tx.$id)).status).toBe('failed');
    expect(await takenOf(ledgerId)).toBe(1);
  });

  it('B/E: 20 concurrent placements on a capacity-3 ledger place exactly 3 (zero oversold)', async () => {
    const { week, ageGroup, ledgerId } = await ledger(3, 0);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        placeGroup(db, {
          programId,
          familyId: `fam-race-${i}`,
          week,
          members: [{ childId: child(`race${i}`), ageGroup }],
          idempotencyKey: `race-${RUN_ID}-${i}`,
          permissions: perms,
        }),
      ),
    );
    const placed = results.filter((r) => r.status === 'placed').length;
    const refused = results.filter((r) => r.status === 'no_capacity').length;
    expect({ placed, refused }).toEqual({ placed: 3, refused: 17 });
    expect(await takenOf(ledgerId)).toBe(3);
    expect(await placementsIn(week)).toBe(3);
  });
});

describe('G: sibling groups are all-or-nothing', () => {
  it('rolls back the whole family when one sibling fits and the other does not', async () => {
    const week = `WS-${RUN_ID}`.slice(0, 16);
    const young = await db.createRow('seat_ledger', newId(), {
      program_id: programId, week, week_start: '2027-06-14T00:00:00.000Z', age_group: '6-8', min_age: 6, max_age: 8, capacity: 1, taken: 0,
    });
    const old = await db.createRow('seat_ledger', newId(), {
      program_id: programId, week, week_start: '2027-06-14T00:00:00.000Z', age_group: '9-11', min_age: 9, max_age: 11, capacity: 1, taken: 1,
    });
    const result = await placeGroup(db, {
      programId,
      familyId: 'fam-sib',
      week,
      members: [
        { childId: child('sibA'), ageGroup: '6-8' },
        { childId: child('sibB'), ageGroup: '9-11' },
      ],
      idempotencyKey: `sib-${RUN_ID}`,
      permissions: perms,
    });
    expect(result.status).toBe('no_capacity');
    expect(await takenOf(young.$id)).toBe(0);
    expect(await takenOf(old.$id)).toBe(1);
    expect(await placementsIn(week)).toBe(0);
  });

  it('places both siblings atomically when both fit', async () => {
    const { week, ageGroup, ledgerId } = await ledger(2, 0);
    const result = await placeGroup(db, {
      programId,
      familyId: 'fam-sib2',
      week,
      members: [
        { childId: child('sibC'), ageGroup },
        { childId: child('sibD'), ageGroup },
      ],
      idempotencyKey: `sib2-${RUN_ID}`,
      permissions: perms,
    });
    expect(result).toMatchObject({ status: 'placed', ledgers: [{ taken: 2, capacity: 2 }] });
    expect(await takenOf(ledgerId)).toBe(2);
  });
});

describe('H: uniqueness, conflicts and safe retries', () => {
  it('a child cannot be placed twice in the same week (unique index → transaction_conflict → classified)', async () => {
    const { week, ageGroup, ledgerId } = await ledger(5, 0);
    const base = { programId, familyId: 'fam-dup', week, members: [{ childId: child('dup'), ageGroup }], permissions: perms };
    expect((await placeGroup(db, { ...base, idempotencyKey: `dup1-${RUN_ID}` })).status).toBe('placed');
    const second = await placeGroup(db, { ...base, idempotencyKey: `dup2-${RUN_ID}` });
    expect(second).toEqual({ status: 'already_placed', childIds: [child('dup')] });
    expect(await takenOf(ledgerId)).toBe(1);
    expect(await placementsIn(week)).toBe(1);
  });

  it('the unique index alone (not just the deterministic ID) blocks a second (child, week) row', async () => {
    const { week, ageGroup, ledgerId } = await ledger(5, 0);
    const data = { program_id: programId, child_id: child('idx'), family_id: 'f', ledger_id: ledgerId, week, age_group: ageGroup, status: 'offered' as const };
    await db.createRow('placements', placementRowId(programId, child('idx'), week), data);
    const err = await capture(() => db.createRow('placements', ID.unique(), data));
    expect(err.mapped).toMatchObject({ kind: 'conflict', status: 409 });
  });

  it('repeating a request with the same idempotency key returns the original result and takes no seat', async () => {
    const { week, ageGroup, ledgerId } = await ledger(5, 0);
    const input = { programId, familyId: 'fam-idem', week, members: [{ childId: child('idem'), ageGroup }], idempotencyKey: `idem-${RUN_ID}`, permissions: perms };
    const first = await placeGroup(db, input);
    const again = await placeGroup(db, input);
    expect(first.status).toBe('placed');
    expect(again).toEqual({ status: 'replayed', placementIds: first.status === 'placed' ? first.placementIds : [] });
    expect(await takenOf(ledgerId)).toBe(1);
  });

  it('5 simultaneous duplicates of one request commit exactly once', async () => {
    const { week, ageGroup, ledgerId } = await ledger(5, 0);
    const input = { programId, familyId: 'fam-burst', week, members: [{ childId: child('burst'), ageGroup }], idempotencyKey: `burst-${RUN_ID}`, permissions: perms };
    const results = await Promise.all(Array.from({ length: 5 }, () => placeGroup(db, input)));
    expect(results.filter((r) => r.status === 'placed')).toHaveLength(1);
    expect(results.every((r) => r.status === 'placed' || r.status === 'replayed')).toBe(true);
    expect(await takenOf(ledgerId)).toBe(1);
  });

  it('a genuine optimistic conflict surfaces as transaction_conflict and the loser can retry safely', async () => {
    const { ledgerId } = await ledger(10, 0);
    const tx1 = await db.transactions.begin(60);
    const tx2 = await db.transactions.begin(60);
    await db.updateRow('seat_ledger', ledgerId, { capacity: 11 }, { transactionId: tx1.$id });
    await db.updateRow('seat_ledger', ledgerId, { capacity: 12 }, { transactionId: tx2.$id });
    await db.transactions.commit(tx1.$id);
    const err = await capture(() => db.transactions.commit(tx2.$id));
    expect(err.mapped).toMatchObject({ kind: 'transaction_conflict', status: 409, retryable: true });

    const retry = await db.transactions.begin(60);
    await db.updateRow('seat_ledger', ledgerId, { capacity: 12 }, { transactionId: retry.$id });
    await db.transactions.commit(retry.$id);
    expect((await db.getRow('seat_ledger', ledgerId)).capacity).toBe(12);
  });
});

describe('Constraint 6/9: append-only, hash-chained, pseudonymous audit log', () => {
  it('appends a valid chain, including under concurrent writers', async () => {
    await appendAudit(db, { programId, event: 'window_opened', payload: { drand_round: 1234 } });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => appendAudit(db, { programId, event: 'family_submitted', payload: { public_id: `pub${i}` } })),
    );
    const { rows } = await db.listRows('audit_log', [Query.equal('program_id', programId), Query.orderAsc('seq'), Query.limit(100)]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(verifyChain(rows)).toEqual({ ok: true });

    const tampered = rows.map((r, i) => (i === 2 ? { ...r, payload: '{"public_id":"forged"}' } : r));
    expect(verifyChain(tampered)).toMatchObject({ ok: false, seq: 3 });
  });

  it('refuses payloads containing personal data', async () => {
    await expect(appendAudit(db, { programId, event: 'bad', payload: { first_name: 'Ada' } })).rejects.toThrow(/personal data/);
  });
});
