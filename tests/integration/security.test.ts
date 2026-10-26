/**
 * Task 14 security review, against the DEPLOYED api/jobs Functions and real
 * TablesDB permissions (browser SDK, same paths as the web app). Requires
 * `npm run functions:deploy` and `npm run db:provision`. Every account and row
 * is synthetic and removed afterwards. Results: docs/TEST-REPORT.md.
 */
import { randomUUID } from 'node:crypto';
import { Account, AppwriteException, Client as BrowserClient, ExecutionMethod, Functions, Teams, TablesDB as BrowserTablesDB } from 'appwrite';
import { ID, Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applicationRowId, preferenceRowId, submitApplication } from '../../functions/shared/applications.ts';
import { AppError } from '../../functions/shared/app-error.ts';
import { clientIpHash, newPublicId } from '../../functions/shared/crypto.ts';
import { destroySandbox, MAX_SANDBOXES_PER_IP, openSandbox, sandboxRowId } from '../../functions/shared/sandbox.ts';
import type { FunctionResponse } from '../../functions/shared/function-runtime.ts';
import { addChild, createHousehold, guardianRowId } from '../../functions/shared/household.ts';
import { createProgram, ledgerRowId, publishProgram, replaceSessions } from '../../functions/shared/organiser.ts';
import { placeGroup } from '../../functions/shared/placement.ts';
import type { TableKey } from '../../shared/config.ts';
import { OFFER_TTL_MS } from '../../shared/offer-lifecycle.ts';
import { parseSessionsCsv, programDetailsSchema } from '../../shared/program-input.ts';
import { aw, createSyntheticUser, db, RUN_ID, serverEnv, syntheticProgram } from './helpers/server.ts';

type U = Awaited<ReturnType<typeof createSyntheticUser>>;
const DB = serverEnv.databaseId;
const teamId = serverEnv.organiserTeamId ?? '';
const secret = serverEnv.childKeySecret ?? '';
const programId = `itsec-${RUN_ID}`.slice(0, 36);
const demoProgramId = `itsecd-${RUN_ID}`.slice(0, 36);
const drawnProgramId = `itsecx-${RUN_ID}`.slice(0, 36);
const key = () => randomUUID().replaceAll('-', '');
let A: U, B: U, C: U, ORG: U;
let anon: { client: BrowserClient; userId: string };
let familyA = '', childA = '', placementA = '';
const responses: string[] = []; // every response body seen, scanned for secrets at the end

const guestClient = () => new BrowserClient().setEndpoint(serverEnv.endpoint).setProject(serverEnv.projectId);

async function exec<T = unknown>(client: BrowserClient, functionId: 'api' | 'jobs', body: Record<string, unknown> | string) {
  try {
    const ex = await new Functions(client).createExecution({ functionId, body: typeof body === 'string' ? body : JSON.stringify(body), async: false, method: ExecutionMethod.POST, headers: { 'content-type': 'application/json' } });
    responses.push(ex.responseBody);
    return { status: ex.responseStatusCode, body: JSON.parse(ex.responseBody) as FunctionResponse<T> };
  } catch (err) {
    // The platform refused before the Function ran (e.g. guests without execute permission).
    if (err instanceof AppwriteException) return { status: err.code, body: { ok: false, error: { code: err.type, message: err.message } } as FunctionResponse<T> };
    throw err;
  }
}
const api = <T = unknown>(client: BrowserClient, body: Record<string, unknown>) => exec<T>(client, 'api', body);
const code = (r: { body: FunctionResponse<unknown> }) => (r.body.ok ? 'ok' : r.body.error.code);
const sdkStatus = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e instanceof AppwriteException ? e.code : -1));

const CSV = 'week,week_start,age_group,min_age,max_age,capacity\nW1,2027-06-21,6-8,6,8,4\nW2,2027-06-28,6-8,6,8,4\n';

beforeAll(async () => {
  if (!teamId || secret.length < 32) throw new Error('APPWRITE_ORGANISER_TEAM_ID and CHILD_KEY_SECRET must be set');
  [A, B, C, ORG] = await Promise.all([createSyntheticUser('secA'), createSyntheticUser('secB'), createSyntheticUser('secC'), createSyntheticUser('secOrg')]);
  await aw.teams.createMembership({ teamId, roles: ['organiser'], userId: ORG.userId });
  // An account without an email, as an anonymous (judge demo) session has. (The browser SDK keeps
  // the anonymous session in a cookie, which Node has no jar for, so the session comes from the server.)
  const anonId = ID.unique();
  await aw.users.create({ userId: anonId, name: '[SYNTHETIC] anonymous' });
  const anonSession = await aw.users.createSession({ userId: anonId });
  anon = { client: guestClient().setSession(anonSession.secret), userId: anonId };

  // An open production program owned by the organiser team.
  const now = Date.now();
  await createProgram(db, teamId, programDetailsSchema.parse({ name: `[SYNTHETIC] security ${RUN_ID}`, timezone: 'UTC', windowOpen: new Date(now - 3600_000).toISOString(), windowClose: new Date(now + 3 * 86400_000).toISOString(), maxWeeks: 2, defaultTier: 1, tierLabels: { '0': 'Zone', '1': 'Everyone' } }), { programId, synthetic: true });
  await replaceSessions(db, teamId, programId, parseSessionsCsv(CSV).sessions);
  await publishProgram(db, teamId, programId);

  // Household A with a child (server code, as the household area would do it).
  familyA = (await createHousehold(db, A.userId)).familyId;
  await createHousehold(db, B.userId);
  childA = (await addChild(db, A.userId, { firstName: 'Secura', lastName: 'Synthetic', birthdate: '2020-03-02' }, () => ID.unique())).$id;

  // A demo sandbox program (TEST-ONLY row) that belongs to someone else.
  await db.createRow('programs', demoProgramId, syntheticProgram({ status: 'open', org_team_id: 'sbx-someone', namespace: 'demo', sandbox_owner: 'someone-else', window_open: new Date(now - 3600_000).toISOString(), window_close: new Date(now + 86400_000).toISOString() }));

  // A drawn program where family A holds an offer (seat taken through placeGroup).
  await db.createRow('programs', drawnProgramId, syntheticProgram({ status: 'drawn', org_team_id: teamId, offers_issued_at: new Date().toISOString() }));
  await db.createRow('seat_ledger', ledgerRowId(drawnProgramId, 'W1', '6-8'), { program_id: drawnProgramId, week: 'W1', week_start: '2027-06-21T00:00:00.000Z', age_group: '6-8', min_age: 6, max_age: 8, capacity: 2, taken: 0 });
  await db.createRow('applications', applicationRowId(drawnProgramId, familyA), { program_id: drawnProgramId, family_id: familyA, public_id: newPublicId(), status: 'submitted', sibling_mode: 'independent', synthetic: true });
  await db.createRow('preferences', preferenceRowId(drawnProgramId, childA), { program_id: drawnProgramId, family_id: familyA, child_id: childA, ranked_weeks: ['W1'], requested_weeks: 1, held_weeks: 0 });
  const placed = await placeGroup(db, {
    programId: drawnProgramId, familyId: familyA, week: 'W1', members: [{ childId: childA, ageGroup: '6-8' }], idempotencyKey: `sec:${drawnProgramId}`, permissions: [], offerTtlMs: OFFER_TTL_MS,
    stage: async (transactionId) => { await db.incrementRowColumn('preferences', preferenceRowId(drawnProgramId, childA), 'held_weeks', { value: 1, max: 1, transactionId }); },
  });
  if (placed.status !== 'placed') throw new Error('setup failed');
  placementA = placed.placementIds[0] ?? '';
}, 300_000);

afterAll(async () => {
  for (const p of [programId, demoProgramId, drawnProgramId]) {
    for (const t of ['placements', 'waitlist', 'idempotency', 'preferences', 'applications', 'tickets', 'link_requests', 'seat_ledger', 'offer_stats', 'audit_log', 'zones'] as TableKey[]) {
      await db.deleteRowsWhere(t, [Query.equal('program_id', p)]).catch(() => undefined);
    }
    await db.deleteRow('programs', p).catch(() => undefined);
  }
  for (const u of [A, B, C]) {
    const g = await db.getRow('guardians', guardianRowId(u.userId)).catch(() => null);
    if (g) {
      for (const t of ['children', 'family_locations', 'guardian_invites', 'guardians'] as TableKey[]) await db.deleteRowsWhere(t, [Query.equal('family_id', g.family_id)]).catch(() => undefined);
      await db.deleteRow('families', g.family_id).catch(() => undefined);
    }
  }
  await db.deleteRowsWhere('rate_limits', [Query.greaterThan('window_start', new Date(Date.now() - 2 * 86400_000).toISOString())]).catch(() => undefined);
  await Promise.all([A.remove(), B.remove(), C.remove(), ORG.remove(), aw.users.delete({ userId: anon.userId }).catch(() => undefined)]);
}, 300_000);

describe('unauthenticated and unauthorised privileged actions', () => {
  it('a guest without a session cannot execute either Function', async () => {
    expect((await api(guestClient(), { area: 'household', action: 'get' })).status).toBe(401);
    expect((await exec(guestClient(), 'jobs', { job: 'odds' })).status).toBe(401);
  });

  it('an anonymous (demo) session cannot create households or enter production lotteries', async () => {
    const r = await api(anon.client, { area: 'household', action: 'createHousehold' });
    expect([r.status, code(r)]).toEqual([403, 'forbidden']);
  });

  it('families and anonymous sessions are refused every organiser, console and jobs action', async () => {
    for (const client of [B.client, anon.client]) {
      expect((await api(client, { area: 'console', programId, command: { action: 'demand' } })).status).toBe(403);
      expect((await api(client, { area: 'organiser', action: 'checkPublish', programId })).status).toBe(403);
      expect((await api(client, { area: 'offers', action: 'overview', programId: drawnProgramId })).status).toBe(403);
      expect((await exec(client, 'jobs', { job: 'offers', programId: drawnProgramId })).status).toBe(403);
    }
  });

  it('organisers cannot reach demo sandboxes through production areas', async () => {
    expect((await api(ORG.client, { area: 'console', programId: demoProgramId, command: { action: 'demand' } })).status).toBe(404);
  });
});

describe('organiser role escalation', () => {
  it('a family cannot add itself to the organiser team or write program/seat tables directly', async () => {
    expect(await sdkStatus(new Teams(B.client).createMembership({ teamId, roles: ['owner'], email: `synthetic+esc-${RUN_ID}@example.com` }))).not.toBe(200);
    const tables = new BrowserTablesDB(B.client);
    expect(await sdkStatus(tables.updateRow({ databaseId: DB, tableId: 'programs', rowId: programId, data: { org_team_id: 'mine' } as Record<string, unknown> }))).toBe(401);
    expect(await sdkStatus(tables.updateRow({ databaseId: DB, tableId: 'seat_ledger', rowId: ledgerRowId(programId, 'W1', '6-8'), data: { capacity: 999 } as Record<string, unknown> }))).toBe(401);
    expect(await sdkStatus(tables.createRow({ databaseId: DB, tableId: 'placements', rowId: ID.unique(), data: { program_id: programId } as Record<string, unknown> }))).toBe(401);
    const member = await aw.teams.listMemberships({ teamId, queries: [Query.equal('userId', B.userId)] });
    expect(member.total).toBe(0);
  });
});

describe('cross-family access', () => {
  it("B cannot read A's child, location or offer through the database", async () => {
    const tables = new BrowserTablesDB(B.client);
    expect(await sdkStatus(tables.getRow({ databaseId: DB, tableId: 'children', rowId: childA }))).toBe(404);
    expect(await sdkStatus(tables.getRow({ databaseId: DB, tableId: 'placements', rowId: placementA }))).toBe(404);
    expect((await tables.listRows({ databaseId: DB, tableId: 'children', queries: [Query.equal('family_id', familyA)] })).total).toBe(0);
  });

  it("B cannot edit, register or apply with A's child through the api", async () => {
    expect(code(await api(B.client, { area: 'household', action: 'updateChild', childId: childA, child: { firstName: 'X', lastName: 'Y', birthdate: '2020-03-02' } }))).toBe('not_found');
    expect(code(await api(B.client, { area: 'household', action: 'registerTicket', programId, childId: childA }))).toBe('not_found');
    const app = { programId, siblingMode: 'independent', children: [{ childId: childA, rankedWeeks: ['W1'], requestedWeeks: 1 }], idempotencyKey: key() };
    expect(code(await api(B.client, { area: 'household', action: 'submitApplication', application: app }))).toBe('not_found');
  });
});

describe('forged IDs and replay manipulation', () => {
  it("forged, foreign and cross-program offer IDs are all 'not found'", async () => {
    const respond = (client: BrowserClient, placementIds: string[], pid = drawnProgramId) => api(client, { area: 'offers', action: 'respond', programId: pid, placementIds, response: 'decline', idempotencyKey: key() });
    expect(code(await respond(B.client, [placementA]))).toBe('not_found');
    expect(code(await respond(A.client, [`pl${key()}`.slice(0, 36)]))).toBe('not_found');
    // Another program's ID: refused before the placement is even looked up (no offers there yet).
    expect(['not_found', 'locked']).toContain(code(await respond(A.client, [placementA], programId)));
    expect(code(await api(B.client, { area: 'household', action: 'dismissLinkRequest', linkRequestId: `lr${key()}`.slice(0, 36) }))).toBe('not_found');
    expect((await db.getRow('placements', placementA)).status).toBe('offered');
  });

  it('an offer reply key reused for a different reply is refused', async () => {
    const idempotencyKey = key();
    const first = await api(A.client, { area: 'offers', action: 'respond', programId: drawnProgramId, placementIds: [placementA], response: 'accept', idempotencyKey });
    expect(code(first)).toBe('ok');
    const forged = await api(A.client, { area: 'offers', action: 'respond', programId: drawnProgramId, placementIds: [placementA], response: 'decline', idempotencyKey });
    expect([forged.status, code(forged)]).toEqual([409, 'conflict']);
    expect((await db.getRow('placements', placementA)).status).toBe('accepted');
    expect((await db.getRow('seat_ledger', ledgerRowId(drawnProgramId, 'W1', '6-8'))).taken).toBe(1);
  });

  it("an application key is bound to its household and request: no foreign replay, no silent edit", async () => {
    const idempotencyKey = key();
    const base = { programId, siblingMode: 'independent' as const, children: [{ childId: childA, rankedWeeks: ['W1', 'W2'], requestedWeeks: 1 }], idempotencyKey };
    const first = await submitApplication(db, secret, A.userId, base);
    expect(first.status).toBe('submitted');
    // Same key, edited request: refused instead of "replayed" with the old data.
    const edited = await submitApplication(db, secret, A.userId, { ...base, children: [{ childId: childA, rankedWeeks: ['W2'], requestedWeeks: 1 }] }).catch((e: unknown) => e);
    expect(edited).toBeInstanceOf(AppError);
    expect((edited as AppError).code).toBe('conflict');
    // Household B presenting A's key gets nothing of A's.
    const foreign = await submitApplication(db, secret, B.userId, base).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(AppError);
    expect((foreign as AppError).code).toBe('not_found'); // B does not own the child; A's receipt is not returned
  });
});

describe('client-supplied tier and capacity tampering', () => {
  it('the deployed Function rejects tier fields and capacity values outside the rules', async () => {
    const app = { programId, siblingMode: 'independent', claimedTier: 0, children: [{ childId: childA, rankedWeeks: ['W1'], requestedWeeks: 1 }], idempotencyKey: key() };
    expect(code(await api(A.client, { area: 'household', action: 'submitApplication', application: app }))).toBe('validation');
    const ledgerId = ledgerRowId(programId, 'W1', '6-8');
    for (const capacity of [-1, 10_001, 2.5]) {
      expect(code(await api(ORG.client, { area: 'console', programId, command: { action: 'setCapacity', ledgerId, capacity } })), String(capacity)).toBe('validation');
    }
    expect((await db.getRow('seat_ledger', ledgerId)).capacity).toBe(4);
  });

  it('capacity changed back and forth is applied every time (no silently skipped replay)', async () => {
    const ledgerId = ledgerRowId(programId, 'W2', '6-8');
    const set = (capacity: number) => api<{ status: string }>(ORG.client, { area: 'console', programId, command: { action: 'setCapacity', ledgerId, capacity } });
    const statuses: string[] = [];
    for (const capacity of [6, 4, 6]) {
      const r = await set(capacity);
      statuses.push(r.body.ok ? r.body.data.status : r.body.error.code);
    }
    expect(statuses).toEqual(['changed', 'changed', 'changed']);
    expect((await db.getRow('seat_ledger', ledgerId)).capacity).toBe(6);
  });

  it('nobody can apply into, or register tickets in, a demo sandbox they do not own', async () => {
    expect(code(await api(A.client, { area: 'household', action: 'registerTicket', programId: demoProgramId, childId: childA }))).toBe('not_found');
    expect(code(await api(A.client, { area: 'household', action: 'classifyMyHome', programId: demoProgramId }))).toBe('not_found');
  });
});

describe('rate limiting', () => {
  it('one network cannot hold every demo sandbox (10 active per client IP)', async () => {
    const ip = `203.0.113.${String(Math.floor(Math.random() * 200) + 1)}`; // TEST-NET-3: never a real client
    const now = new Date().toISOString();
    const rows = Array.from({ length: MAX_SANDBOXES_PER_IP }, (_, i) => `itsx-${String(i)}-${RUN_ID}`.slice(0, 36));
    // TEST-ONLY registry rows standing in for 10 active sandboxes opened from that IP.
    for (const owner of rows) {
      await db.createRow('sandboxes', sandboxRowId(owner), { owner_id: owner, team_id: `sbx-${owner}`.slice(0, 36), program_id: `none-${owner}`.slice(0, 36), generation: 1, status: 'ready', reset_count: 0, reset_window_start: now, last_active_at: now, ip_hash: clientIpHash(secret, ip) });
    }
    try {
      const caller = { aw, db, ownerId: `itsx-new-${RUN_ID}`.slice(0, 36), secret, clientIp: ip };
      const refused = await openSandbox(caller).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(AppError);
      expect((refused as AppError).code).toBe('rate_limited');
      expect(await db.getRow('sandboxes', sandboxRowId(caller.ownerId)).catch(() => null)).toBeNull(); // nothing created
      // The cap is per network: the same request from another IP is not refused by it.
      const other = await openSandbox({ ...caller, clientIp: '198.51.100.7' }).then(() => 'opened', (e: unknown) => (e instanceof AppError ? e.code : 'error'));
      expect(other).not.toBe('rate_limited');
      await destroySandbox(aw, db, caller.ownerId).catch(() => undefined);
    } finally {
      for (const owner of rows) await db.deleteRow('sandboxes', sandboxRowId(owner)).catch(() => undefined);
    }
  });

  it('invite code attempts are limited per account (10 an hour), then 429', async () => {
    await createHousehold(db, C.userId).catch(() => undefined);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await api(C.client, { area: 'household', action: 'acceptInvite', code: 'ABCDE23456' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 404 || s === 409)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('email one-time codes are limited by Appwrite (records the observed limit)', async () => {
    const email = `synthetic+otp-${RUN_ID}@example.com`;
    const account = new Account(guestClient());
    let sent = 0;
    let limitedAt: number | null = null;
    for (let i = 0; i < 15 && limitedAt === null; i++) {
      const s = await sdkStatus(account.createEmailToken({ userId: ID.unique(), email }));
      if (s === 429) limitedAt = i + 1;
      else if (s < 300) sent++;
    }
    const user = await aw.users.list({ queries: [Query.equal('email', email)] });
    for (const u of user.users) await aw.users.delete({ userId: u.$id }).catch(() => undefined);
    console.info(`[security] OTP: ${String(sent)} codes sent, 429 at attempt ${String(limitedAt)}`);
    expect(limitedAt).not.toBeNull();
    expect(sent).toBeLessThanOrEqual(10);
  });
});

describe('exposure of secrets, personal information and internal errors', () => {
  it('malformed requests get validation errors with no internals', async () => {
    const bad = await exec(A.client, 'api', '{"area": ');
    expect([bad.status, code(bad)]).toEqual([400, 'validation']);
    const unknown = await api(A.client, { area: 'nope' });
    expect(code(unknown)).toBe('validation');
  });

  it('public tables expose no names, birthdates, emails or coordinates', async () => {
    const guest = new BrowserTablesDB(guestClient());
    for (const table of ['programs', 'audit_log', 'draw_results', 'offer_stats', 'odds_snapshots', 'frozen_inputs', 'seat_ledger', 'zones']) {
      const { rows } = await guest.listRows({ databaseId: DB, tableId: table, queries: [Query.limit(100), Query.orderDesc('$createdAt')] });
      const text = JSON.stringify(rows);
      expect(text, table).not.toMatch(/Secura|first_name|last_name|birthdate|synthetic\+[^"]*@example\.com/);
      expect(text, table).not.toMatch(/"home"/);
    }
    // Private tables are invisible to guests.
    for (const table of ['children', 'family_locations', 'guardians', 'tickets', 'rate_limits', 'idempotency', 'staff_actions']) {
      const status = await guest.listRows({ databaseId: DB, tableId: table, queries: [Query.limit(1)] }).then((r) => (r.total === 0 ? 'empty' : 'visible'), (e: unknown) => (e instanceof AppwriteException ? e.code : -1));
      expect(status, table).not.toBe('visible');
    }
  });

  it('no response seen in this suite contains a secret, a stack trace or a server path', () => {
    const all = responses.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const s of [serverEnv.apiKey, secret].filter((x) => x.length > 8)) expect(all.includes(s)).toBe(false);
    expect(all).not.toMatch(/\bat [\w.]+ \(|node_modules|\/usr\/|\\src\\|stack/);
  });
});
