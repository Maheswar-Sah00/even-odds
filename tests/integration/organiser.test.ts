/**
 * Task 6 against REAL TablesDB: organiser authorisation, draft privacy,
 * session import, publishing, capacity rules and geo classification.
 */
import { Client as BrowserClient, ExecutionMethod, Functions, TablesDB as BrowserTablesDB } from 'appwrite';
import { ID, Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../functions/shared/app-error.ts';
import { classifyPoint, createProgram, ledgerRowId, publishProgram, replaceSessions, replaceZones, requireOrganiser, setCapacity } from '../../functions/shared/organiser.ts';
import { distanceToEdgeM, type LngLat } from '../../shared/geo.ts';
import { parseSessionsCsv, programDetailsSchema, type ZoneInput } from '../../shared/program-input.ts';
import type { TableKey } from '../../shared/config.ts';
import { aw, createSyntheticUser, db, RUN_ID, serverEnv } from './helpers/server.ts';

const DB = serverEnv.databaseId;
const teamId = `itest-org-${RUN_ID}`.slice(0, 36);
const programId = `itp-${RUN_ID}`.slice(0, 36);
type U = Awaited<ReturnType<typeof createSyntheticUser>>;
let organiser: U, family: U;
const guest = () => new BrowserTablesDB(new BrowserClient().setEndpoint(serverEnv.endpoint).setProject(serverEnv.projectId));

const details = programDetailsSchema.parse({
  name: `[SYNTHETIC] itest program ${RUN_ID}`,
  description: 'Integration test',
  timezone: 'America/New_York',
  windowOpen: new Date(Date.now() - 3600_000).toISOString(),
  windowClose: new Date(Date.now() + 7 * 86400_000).toISOString(),
  maxWeeks: 2,
  defaultTier: 2,
  tierLabels: { '0': 'Core', '1': 'Outer', '2': 'Everyone else' },
});

// Square A (tier 0) inside square B (tier 1); [lng, lat].
const square = (w: number, s: number, e: number, n: number): LngLat[][] => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
const zones: ZoneInput[] = [
  { name: 'A core', tier: 0, area: square(-77.31, 38.84, -77.29, 38.86) },
  { name: 'B outer', tier: 1, area: square(-77.35, 38.80, -77.25, 38.90) },
];
const csv = 'week,week_start,age_group,min_age,max_age,capacity\nW1,2027-06-21,6-8,6,8,10\nW1,2027-06-21,9-11,9,11,8\nW2,2027-06-28,6-8,6,8,10\n';

const expectAppError = async (p: Promise<unknown>, code: AppError['code']) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
};

beforeAll(async () => {
  [organiser, family] = await Promise.all([createSyntheticUser('org'), createSyntheticUser('fam')]);
  await aw.teams.create({ teamId, name: `[SYNTHETIC] organisers ${RUN_ID}` });
  await aw.teams.createMembership({ teamId, roles: ['organiser'], userId: organiser.userId });
});

afterAll(async () => {
  for (const table of ['seat_ledger', 'zones', 'audit_log'] as TableKey[]) {
    const { rows } = await db.listRows(table, [Query.equal('program_id', programId), Query.limit(200)]);
    await Promise.all(rows.map((r) => db.deleteRow(table, r.$id)));
  }
  await db.deleteRow('programs', programId).catch(() => undefined);
  await aw.teams.delete({ teamId }).catch(() => undefined);
  await Promise.all([organiser.remove(), family.remove()]);
});

describe('organiser authorisation', () => {
  it('confirmed team members pass; other users are refused', async () => {
    await requireOrganiser(aw.teams, teamId, organiser.userId);
    await expectAppError(requireOrganiser(aw.teams, teamId, family.userId), 'forbidden');
  });

  it('the deployed organiser Function refuses a non-organiser', async () => {
    const ex = await new Functions(family.client).createExecution({ functionId: 'api', body: JSON.stringify({ area: 'organiser', action: 'publish', programId }), async: false, method: ExecutionMethod.POST });
    expect(ex.responseStatusCode).toBe(403);
    expect(JSON.parse(ex.responseBody)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });
});

describe('draft → publish', () => {
  it('a draft program and its sessions are visible to organisers only', async () => {
    await createProgram(db, teamId, details, { programId, synthetic: true });
    const parsed = parseSessionsCsv(csv);
    expect(parsed.errors).toEqual([]);
    await replaceSessions(db, teamId, programId, parsed.sessions);
    await replaceZones(db, teamId, programId, zones);

    await expect(guest().getRow({ databaseId: DB, tableId: 'programs', rowId: programId })).rejects.toMatchObject({ code: 404 });
    await expect(family.tablesDB.getRow({ databaseId: DB, tableId: 'programs', rowId: programId })).rejects.toMatchObject({ code: 404 });
    expect((await guest().listRows({ databaseId: DB, tableId: 'seat_ledger', queries: [Query.equal('program_id', programId)] })).total).toBe(0);
    const forOrg = await organiser.tablesDB.listRows({ databaseId: DB, tableId: 'seat_ledger', queries: [Query.equal('program_id', programId)] });
    expect(forOrg.total).toBe(3);
  });

  it('re-importing the same sessions is a no-op; dropping a row removes that session', async () => {
    const parsed = parseSessionsCsv(csv);
    await expect(replaceSessions(db, teamId, programId, parsed.sessions)).resolves.toEqual({ upserted: 3, removed: 0 });
    const fewer = parseSessionsCsv(csv.split('\n').slice(0, 3).join('\n'));
    await expect(replaceSessions(db, teamId, programId, fewer.sessions)).resolves.toEqual({ upserted: 2, removed: 1 });
    await replaceSessions(db, teamId, programId, parsed.sessions);
  });

  it('publishing makes the program, sessions and zones public and writes an audit entry', async () => {
    await publishProgram(db, teamId, programId);
    const p = await guest().getRow({ databaseId: DB, tableId: 'programs', rowId: programId });
    expect(p['status']).toBe('open');
    expect((await guest().listRows({ databaseId: DB, tableId: 'seat_ledger', queries: [Query.equal('program_id', programId)] })).total).toBe(3);
    expect((await guest().listRows({ databaseId: DB, tableId: 'zones', queries: [Query.equal('program_id', programId)] })).total).toBe(2);
    const audit = await guest().listRows({ databaseId: DB, tableId: 'audit_log', queries: [Query.equal('program_id', programId)] });
    expect(audit.rows.map((r) => String(r['event']))).toEqual(['program_published']);
  });

  it('after publishing, structure is locked but capacity can still rise, never below seats taken', async () => {
    await expectAppError(replaceSessions(db, teamId, programId, parseSessionsCsv(csv).sessions), 'locked');
    await expectAppError(replaceZones(db, teamId, programId, zones), 'locked');
    const ledgerId = ledgerRowId(programId, 'W1', '6-8');
    await db.incrementRowColumn('seat_ledger', ledgerId, 'taken', { value: 4, max: 10 });
    await expect(setCapacity(db, teamId, programId, ledgerId, 12)).resolves.toMatchObject({ capacity: 12 });
    await expectAppError(setCapacity(db, teamId, programId, ledgerId, 3), 'conflict');
  });

  it('guests and families cannot write catalogue rows directly', async () => {
    await expect(family.tablesDB.updateRow({ databaseId: DB, tableId: 'seat_ledger', rowId: ledgerRowId(programId, 'W1', '6-8'), data: { capacity: 999 } as Record<string, unknown> })).rejects.toMatchObject({ code: 401 });
    await expect(guest().createRow({ databaseId: DB, tableId: 'zones', rowId: ID.unique(), data: { program_id: programId } as Record<string, unknown> })).rejects.toBeDefined();
  });
});

describe('zone classification (real Query.intersects / distanceLessThan)', () => {
  const at = async (point: LngLat) => classifyPoint(db, await db.getRow('programs', programId), point);
  // Roughly: 0.001 deg lng ≈ 86.6 m, 0.001 deg lat ≈ 111 m at this latitude.

  it('inside both zones takes the better (lower) tier', async () => {
    await expect(at([-77.30, 38.85])).resolves.toMatchObject({ tier: 0, nearBoundary: false, containingZones: 2 });
  });

  it('inside the outer zone only', async () => {
    await expect(at([-77.33, 38.82])).resolves.toMatchObject({ tier: 1, nearBoundary: false });
  });

  it('outside every zone gets the default tier', async () => {
    await expect(at([-77.10, 38.95])).resolves.toMatchObject({ tier: 2, nearBoundary: false, containingZones: 0 });
  });

  it('inside a zone but ~26 m from its edge is flagged for verification', async () => {
    const p: LngLat = [-77.2903, 38.85];
    expect(distanceToEdgeM(p, zones[0]?.area ?? [])).toBeLessThan(50);
    await expect(at(p)).resolves.toMatchObject({ tier: 0, nearBoundary: true });
  });

  it('just outside a zone (~35 m) is flagged by the database distance query', async () => {
    await expect(at([-77.3504, 38.85])).resolves.toMatchObject({ tier: 2, nearBoundary: true, containingZones: 0 });
  });

  it('exactly on an edge counts as inside (database semantics) and is flagged', async () => {
    await expect(at([-77.29, 38.85])).resolves.toMatchObject({ tier: 0, nearBoundary: true });
  });
});
