/**
 * Task 5 household rules against REAL TablesDB, using real users and real
 * browser-SDK sessions for every read-permission check.
 */
import { ID, Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../functions/shared/app-error.ts';
import {
  acceptInvite,
  addChild,
  createHousehold,
  createInvite,
  getHousehold,
  registerTicket,
  updateChild,
} from '../../functions/shared/household.ts';
import type { TableKey } from '../../shared/config.ts';
import { createCleanup, createSyntheticUser, db, aw, newId, RUN_ID, serverEnv, syntheticProgram } from './helpers/server.ts';

const DB = serverEnv.databaseId;
const secret = serverEnv.childKeySecret ?? '';
const cleanup = createCleanup();
const programId = newId();
const teamId = `itest-hh-${RUN_ID}`.slice(0, 36);
type U = Awaited<ReturnType<typeof createSyntheticUser>>;
let A: U, B: U, C: U, D: U;
const families = new Set<string>();

const expectAppError = async (p: Promise<unknown>, code: AppError['code']) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
};

beforeAll(async () => {
  if (secret.length < 32) throw new Error('CHILD_KEY_SECRET must be set in .env.server');
  [A, B, C, D] = await Promise.all([createSyntheticUser('hhA'), createSyntheticUser('hhB'), createSyntheticUser('hhC'), createSyntheticUser('hhD')]);
  await aw.teams.create({ teamId, name: `[SYNTHETIC] organisers ${RUN_ID}` });
  cleanup.track('programs', programId);
  const now = Date.now();
  await db.createRow('programs', programId, syntheticProgram({ org_team_id: teamId, status: 'open', window_open: new Date(now - 3600_000).toISOString(), window_close: new Date(now + 86400_000).toISOString() }));
});

afterAll(async () => {
  const tables: TableKey[] = ['link_requests', 'tickets', 'children', 'guardian_invites', 'guardians', 'families'];
  for (const table of tables) {
    for (const familyId of families) {
      const { rows } = await db.listRows(table, [Query.equal(table === 'families' ? '$id' : 'family_id', familyId), Query.limit(100)]);
      await Promise.all(rows.map((r) => db.deleteRow(table, r.$id)));
    }
  }
  await cleanup.run();
  await aw.teams.delete({ teamId }).catch(() => undefined);
  await Promise.all([A, B, C, D].map((u) => u.remove()));
});

const ada = { firstName: 'Ada', lastName: 'Lovelace', birthdate: '2018-12-10' };
let familyA = '';
let adaId = '';

describe('households', () => {
  it('creating a household is idempotent, even for simultaneous requests', async () => {
    const results = await Promise.all([createHousehold(db, A.userId), createHousehold(db, A.userId), createHousehold(db, A.userId)]);
    familyA = results[0].familyId;
    families.add(familyA);
    expect(new Set(results.map((r) => r.familyId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const guardians = await db.listRows('guardians', [Query.equal('family_id', familyA)]);
    expect(guardians.total).toBe(1);
  });

  it('guardians add children; the same child twice in one household is refused', async () => {
    const child = await addChild(db, A.userId, ada, () => ID.unique());
    adaId = child.$id;
    await addChild(db, A.userId, { firstName: 'Byron', lastName: 'Lovelace', birthdate: '2020-03-01' }, () => ID.unique());
    await expectAppError(addChild(db, A.userId, { ...ada, firstName: ' ADA ' }, () => ID.unique()), 'conflict');
  });

  it('a guardian reads their own children through row permissions; another account sees nothing', async () => {
    const own = await A.tablesDB.listRows({ databaseId: DB, tableId: 'children', queries: [Query.equal('family_id', familyA)] });
    expect(own.rows.map((r) => r['first_name'] as string).sort()).toEqual(['Ada', 'Byron']);

    const other = await B.tablesDB.listRows({ databaseId: DB, tableId: 'children', queries: [Query.equal('family_id', familyA)] });
    expect(other.total).toBe(0);
    await expect(B.tablesDB.getRow({ databaseId: DB, tableId: 'children', rowId: adaId })).rejects.toMatchObject({ code: 404 });
  });

  it("another account cannot edit or register a household's child (looks like not found)", async () => {
    const { familyId } = await createHousehold(db, B.userId);
    families.add(familyId);
    await expectAppError(updateChild(db, secret, B.userId, adaId, ada), 'not_found');
    await expectAppError(registerTicket(db, secret, B.userId, programId, adaId), 'not_found');
  });

  it('a user without a household cannot add children', async () => {
    await expectAppError(addChild(db, D.userId, ada, () => ID.unique()), 'not_found');
  });
});

describe('guardian invites', () => {
  let code = '';

  it('a second guardian joins with a single-use code and immediately gains read access', async () => {
    ({ code } = await createInvite(db, A.userId, () => ID.unique()));
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    const stored = await db.listRows('guardian_invites', [Query.equal('family_id', familyA)]);
    expect(JSON.stringify(stored.rows)).not.toContain(code); // only the hash is stored

    await expect(acceptInvite(db, C.userId, code)).resolves.toEqual({ familyId: familyA });
    const visible = await C.tablesDB.listRows({ databaseId: DB, tableId: 'children', queries: [Query.equal('family_id', familyA)] });
    expect(visible.total).toBe(2);
    const summary = await getHousehold(db, aw.users, C.userId);
    expect(summary?.guardians.map((g) => g.role).sort()).toEqual(['linked', 'primary']);
  });

  it('accepting again is idempotent; the code cannot be reused by anyone else', async () => {
    await expect(acceptInvite(db, C.userId, code)).resolves.toEqual({ familyId: familyA });
    await expectAppError(acceptInvite(db, D.userId, code), 'not_found');
  });

  it('expired invites are refused, and members of another household cannot join', async () => {
    const old = await createInvite(db, A.userId, () => ID.unique(), new Date(Date.now() - 73 * 3600_000));
    await expectAppError(acceptInvite(db, D.userId, old.code), 'expired');
    const fresh = await createInvite(db, A.userId, () => ID.unique());
    await expectAppError(acceptInvite(db, B.userId, fresh.code), 'conflict');
  });
});

describe('tickets and duplicate children (constraint 1)', () => {
  it('registers a ticket once; repeats and the co-guardian get the same ticket', async () => {
    const first = await registerTicket(db, secret, A.userId, programId, adaId);
    expect(first.status).toBe('registered');
    const again = await Promise.all([registerTicket(db, secret, A.userId, programId, adaId), registerTicket(db, secret, C.userId, programId, adaId)]);
    expect(again.map((r) => r.status)).toEqual(['already_registered', 'already_registered']);
    const tickets = await db.listRows('tickets', [Query.equal('program_id', programId), Query.equal('family_id', familyA)]);
    expect(tickets.total).toBe(1);
    expect(tickets.rows[0]?.child_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a second household's ticket for the same child is blocked without revealing anything about the first", async () => {
    const familyB = (await createHousehold(db, B.userId)).familyId;
    const copy = await addChild(db, B.userId, { firstName: 'ada', lastName: 'LOVELACE', birthdate: '2018-12-10' }, () => ID.unique());
    const result = await registerTicket(db, secret, B.userId, programId, copy.$id);
    expect(result).toEqual({ status: 'possible_duplicate' });
    expect(JSON.stringify(result)).not.toContain(familyA);

    const bTickets = await db.listRows('tickets', [Query.equal('family_id', familyB)]);
    expect(bTickets.total).toBe(0);
    // The existing household is told (via a row only it can read); the requester cannot see it.
    const forA = await A.tablesDB.listRows({ databaseId: DB, tableId: 'link_requests', queries: [Query.equal('family_id', familyA)] });
    expect(forA.total).toBe(1);
    expect(JSON.stringify(forA.rows)).not.toContain(familyB);
    const forB = await B.tablesDB.listRows({ databaseId: DB, tableId: 'link_requests' });
    expect(forB.total).toBe(0);
    // Repeating does not spam the existing household.
    await registerTicket(db, secret, B.userId, programId, copy.$id);
    expect((await db.listRows('link_requests', [Query.equal('family_id', familyA)])).total).toBe(1);
  });

  it('editing a ticketed child INTO another household’s child is refused and notifies that household (Task 14)', async () => {
    const E = await createSyntheticUser('hhE');
    try {
      const familyE = (await createHousehold(db, E.userId)).familyId;
      families.add(familyE);
      const probe = await addChild(db, E.userId, { firstName: 'Edith', lastName: 'Probe', birthdate: '2017-01-01' }, () => ID.unique());
      expect((await registerTicket(db, secret, E.userId, programId, probe.$id)).status).toBe('registered');
      await expectAppError(updateChild(db, secret, E.userId, probe.$id, { firstName: 'ADA', lastName: 'lovelace', birthdate: '2018-12-10' }), 'conflict');
      expect((await db.getRow('children', probe.$id)).first_name).toBe('Edith'); // nothing saved
      expect((await db.listRows('link_requests', [Query.equal('family_id', familyA)])).total).toBe(2); // B earlier, now E
    } finally {
      await E.remove();
    }
  });

  it('organisers can read neither tickets (child_key) nor children (Task 14 least privilege)', async () => {
    const org = await createSyntheticUser('hhOrg');
    try {
      await aw.teams.createMembership({ teamId, roles: ['organiser'], userId: org.userId });
      const t = await org.tablesDB.listRows({ databaseId: DB, tableId: 'tickets', queries: [Query.equal('program_id', programId)] });
      expect(t.total).toBe(0);
      const c = await org.tablesDB.listRows({ databaseId: DB, tableId: 'children' });
      expect(c.total).toBe(0);
    } finally {
      await org.remove();
    }
  });
});

describe('editing children', () => {
  it('edits re-key the ticket so duplicates stay blocked', async () => {
    const before = (await db.listRows('tickets', [Query.equal('child_id', adaId)])).rows[0]?.child_key;
    await updateChild(db, secret, A.userId, adaId, { ...ada, birthdate: '2018-12-11' });
    const after = (await db.listRows('tickets', [Query.equal('child_id', adaId)])).rows[0]?.child_key;
    expect(after).not.toBe(before);
    await updateChild(db, secret, A.userId, adaId, ada);
  });

  it('edits are refused once the program has closed applications', async () => {
    await db.updateRow('programs', programId, { status: 'frozen' });
    try {
      await expectAppError(updateChild(db, secret, A.userId, adaId, { ...ada, firstName: 'Augusta' }), 'locked');
      await expectAppError(registerTicket(db, secret, A.userId, programId, adaId), 'locked');
    } finally {
      await db.updateRow('programs', programId, { status: 'open' });
    }
  });
});
