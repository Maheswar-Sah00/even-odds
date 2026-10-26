/**
 * Constraints 6, 7, 8 against REAL Appwrite: real users with real sessions
 * (created via the Users API), a real organiser Team, and the browser SDK.
 */
import { Client as BrowserClient, TablesDB as BrowserTablesDB } from 'appwrite';
import { ID, Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit } from '../../functions/shared/audit.ts';
import { newPublicId } from '../../functions/shared/crypto.ts';
import { familyRowPermissions, privateLocationPermissions } from '../../functions/shared/permissions.ts';
import { mapAppwriteError } from '../../shared/errors.ts';
import { aw, createCleanup, db, newId, RUN_ID, serverEnv, syntheticProgram } from './helpers/server.ts';

const cleanup = createCleanup();
const programId = newId();
const teamId = `itest-${RUN_ID}`.slice(0, 36);
const userIds = { a: ID.unique(), b: ID.unique(), org: ID.unique() };
const sessions: Record<keyof typeof userIds, BrowserTablesDB> = {} as never;
const familyA = newId();
const familyB = newId();
const locationA = newId();

const DB = serverEnv.databaseId;
const fail = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (err) {
    return mapAppwriteError(err);
  }
  throw new Error('expected failure');
};

async function sessionFor(userId: string): Promise<BrowserTablesDB> {
  const session = await aw.users.createSession({ userId });
  const client = new BrowserClient().setEndpoint(serverEnv.endpoint).setProject(serverEnv.projectId).setSession(session.secret);
  return new BrowserTablesDB(client);
}

beforeAll(async () => {
  for (const [k, id] of Object.entries(userIds)) {
    await aw.users.create({ userId: id, email: `synthetic+${k}-${RUN_ID}@example.com`, name: `[SYNTHETIC] ${k}` });
  }
  await aw.teams.create({ teamId, name: `[SYNTHETIC] organisers ${RUN_ID}` });
  await aw.teams.createMembership({ teamId, roles: ['organiser'], userId: userIds.org });

  cleanup.track('programs', programId);
  await db.createRow('programs', programId, syntheticProgram({ org_team_id: teamId }));
  // familyA/familyB are application rows (per-program, organisers may read); households are 'hh-a'/'hh-b'.
  const application = (householdId: string) => ({
    program_id: programId, family_id: householdId, public_id: newPublicId(), sibling_mode: 'together_only' as const, status: 'submitted' as const, synthetic: true, claimed_tier: 1,
  });
  cleanup.track('applications', familyA);
  await db.createRow('applications', familyA, application('hh-a'), { permissions: familyRowPermissions([userIds.a], teamId) });
  cleanup.track('applications', familyB);
  await db.createRow('applications', familyB, application('hh-b'), { permissions: familyRowPermissions([userIds.b], teamId) });
  cleanup.track('family_locations', locationA);
  await db.createRow('family_locations', locationA, { family_id: 'hh-a', home: [-77.3, 38.85] }, { permissions: privateLocationPermissions([userIds.a]) });

  sessions.a = await sessionFor(userIds.a);
  sessions.b = await sessionFor(userIds.b);
  sessions.org = await sessionFor(userIds.org);
});

afterAll(async () => {
  const { rows } = await db.listRows('audit_log', [Query.equal('program_id', programId), Query.limit(100)]);
  await Promise.all(rows.map((r) => db.deleteRow('audit_log', r.$id)));
  await cleanup.run();
  await aw.teams.delete({ teamId }).catch(() => undefined);
  for (const id of Object.values(userIds)) await aw.users.delete({ userId: id }).catch(() => undefined);
});

describe('Constraint 7: family isolation', () => {
  it('a family sees its own application', async () => {
    const own = await sessions.a.getRow({ databaseId: DB, tableId: 'applications', rowId: familyA });
    expect(own.$id).toBe(familyA);
  });

  it("a family cannot read another family's application, by ID or by listing", async () => {
    expect(await fail(() => sessions.a.getRow({ databaseId: DB, tableId: 'applications', rowId: familyB }))).toMatchObject({ status: 404 });
    const listed = await sessions.a.listRows({ databaseId: DB, tableId: 'applications', queries: [Query.equal('program_id', programId)] });
    expect(listed.rows.map((r) => r.$id)).toEqual([familyA]);
  });

  it('a family cannot modify its own row directly (writes go through server code)', async () => {
    const err = await fail(() => sessions.a.updateRow({ databaseId: DB, tableId: 'applications', rowId: familyA, data: { claimed_tier: 0 } as Record<string, unknown> }));
    expect(err.status).toBe(401);
    expect((await db.getRow('applications', familyA)).claimed_tier).toBe(1);
  });

  it('a family cannot create rows in private tables', async () => {
    const err = await fail(() =>
      sessions.a.createRow({ databaseId: DB, tableId: 'placements', rowId: ID.unique(), data: { program_id: programId } as Record<string, unknown> }),
    );
    expect([400, 401]).toContain(err.status);
    expect(err.status === 401 || err.type === 'row_invalid_structure').toBe(true);
  });
});

describe('Constraint 8: organisers do not see home coordinates', () => {
  it('organisers can read every application (tiers) in their program', async () => {
    const listed = await sessions.org.listRows({ databaseId: DB, tableId: 'applications', queries: [Query.equal('program_id', programId)] });
    expect(listed.rows.map((r) => r.$id).sort()).toEqual([familyA, familyB].sort());
  });

  it('organisers cannot read family_locations; the family can', async () => {
    expect(await fail(() => sessions.org.getRow({ databaseId: DB, tableId: 'family_locations', rowId: locationA }))).toMatchObject({ status: 404 });
    const own = await sessions.a.getRow({ databaseId: DB, tableId: 'family_locations', rowId: locationA });
    expect(own.home).toEqual([-77.3, 38.85]);
    expect(await fail(() => sessions.b.getRow({ databaseId: DB, tableId: 'family_locations', rowId: locationA }))).toMatchObject({ status: 404 });
  });
});

describe('Constraint 6: audit log is append-only for every client', () => {
  it('signed-in users and organisers can read it but cannot create, update or delete', async () => {
    const entry = await appendAudit(db, { programId, event: 'perm_test', payload: { public_id: 'p1' } });
    const { rows } = await sessions.org.listRows({ databaseId: DB, tableId: 'audit_log', queries: [Query.equal('program_id', programId)] });
    expect(rows).toHaveLength(1);
    const rowId = rows[0]?.$id ?? '';
    for (const s of [sessions.a, sessions.org]) {
      expect((await fail(() => s.updateRow({ databaseId: DB, tableId: 'audit_log', rowId, data: { event: 'forged' } as Record<string, unknown> }))).status).toBe(401);
      expect((await fail(() => s.deleteRow({ databaseId: DB, tableId: 'audit_log', rowId }))).status).toBe(401);
      expect(
        (await fail(() =>
          s.createRow({ databaseId: DB, tableId: 'audit_log', rowId: ID.unique(), data: { program_id: programId, seq: 99, event: 'x', payload: '{}', payload_hash: 'x', prev_hash: 'x', entry_hash: 'x' } as Record<string, unknown> }),
        )).status,
      ).toBe(401);
    }
    expect((await db.getRow('audit_log', rowId)).entry_hash).toBe(entry.entry_hash);
  });
});
