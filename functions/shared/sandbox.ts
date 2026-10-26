import { randomBytes } from 'node:crypto';
import { Permission, Query, Role } from 'node-appwrite';
import type { TableKey } from '../../shared/config.ts';
import { DEMO_DUPLICATE_CHILD, DEMO_FAMILIES, DEMO_PROGRAM, DEMO_ROLLBACK_FAMILY, DEMO_SCENARIO_VERSION, DEMO_SESSIONS, DEMO_ZONES, syntheticName } from '../../shared/demo-scenario.ts';
import { weeksForChild } from '../../shared/eligibility.ts';
import { ServiceError } from '../../shared/errors.ts';
import { announcedRound, DRAND_CHAIN, roundTimeMs, TIMING } from '../../shared/freeze/protocol.ts';
import type { OfferResponse } from '../../shared/offer-input.ts';
import { OFFER_TTL_MS } from '../../shared/offer-lifecycle.ts';
import { programDetailsSchema } from '../../shared/program-input.ts';
import { AppError } from './app-error.ts';
import { applicationRowId, preferenceRowId } from './applications.ts';
import type { ServerAppwrite } from './appwrite-server.ts';
import { drawStatus, logStaffAction, privileged, type ConsoleActor } from './console.ts';
import { childKey, clientIpHash, deterministicId, sha256Hex } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { advanceDraw } from './draw-runner.ts';
import { freezeProgram, protocolDrawRunId } from './freeze.ts';
import { allRows, ensureTicket, findRow, isKind, locationRowId, ticketRowId } from './household.ts';
import { assertSandboxOf } from './namespace.ts';
import { respondForHousehold } from './offer-actions.ts';
import { issueOffers, runOfferSweep, serverNow } from './offers.ts';
import { classifyPoint, createProgram, publishProgram, replaceSessions, replaceZones } from './organiser.ts';

/**
 * Judge sandbox (Task 12): one private, pre-seeded demo program per visitor.
 *
 * Isolation, enforced here and in functions/shared/namespace.ts:
 * - The client never names a sandbox or program. Every entry point takes the
 *   platform-set user ID and derives the visitor's sandbox from the server-
 *   only `sandboxes` registry, then asserts the program is a demo program
 *   owned by that visitor (assertSandboxOf) before touching it.
 * - Sandbox rows are readable only through a per-sandbox Appwrite Team
 *   (random ID, created server-side) whose only member is the visitor.
 * - Deletion (reset, idle clean-up) only ever runs on program IDs derived
 *   from the registry and re-checked as demo programs of that visitor.
 *
 * Demo time: fast-forward controls move THIS sandbox's own deadlines earlier
 * (window, offer expiries) and record by how much. They never change any
 * clock: freezes, offer validity and drand rounds are still decided by
 * Appwrite server time and the real drand network.
 *
 * Everything else (freeze, beacon verification, the draw, offers, waitlist,
 * the duplicate block, the seat cap) runs the production code paths against
 * real TablesDB rows; each action returns the database's actual answers as
 * "inspector" steps.
 */

export const SANDBOX_IDLE_MS = 24 * 3600_000;
export const MAX_SANDBOXES = 40;
/** A sandbox counts as active (against MAX_SANDBOXES) for this long after its last request. */
export const SANDBOX_ACTIVE_MS = 30 * 60_000;
/** Active sandboxes one client IP may hold at once. */
export const MAX_SANDBOXES_PER_IP = 10;
export const RESETS_PER_HOUR = 12;
/** Offers last 48 h; "fast-forward 48 h" moves every pending offer's clock back by exactly that. */
export const OFFER_JUMP_MS = OFFER_TTL_MS;
/** Each demo action must answer inside the 30 s synchronous execution limit; the UI calls again to continue. */
const DRAW_BUDGET_MS = 6_000;
const SWEEP_BUDGET_MS = 5_000;

export const sandboxRowId = (ownerId: string) => deterministicId('sx', 'sandbox', ownerId);
export const sandboxProgramId = (ownerId: string, generation: number) => deterministicId('sp', 'sandbox-program', ownerId, String(generation));
export const sandboxFamilyId = (programId: string, key: string) => deterministicId('fa', 'sandbox-family', programId, key);
const sandboxChildId = (programId: string, key: string, index: number) => deterministicId('ch', 'sandbox-child', programId, key, String(index));
const demoPublicId = (programId: string, key: string) => sha256Hex(`demo-public-id\n${programId}\n${key}`).slice(0, 32);
const SECOND_GUARDIAN_KEY = 'rivera-second-guardian';

export interface InspectorStep {
  op: string;
  detail: string;
  outcome: 'ok' | 'refused' | 'info';
}

export interface SandboxCaller {
  aw: ServerAppwrite;
  db: ServerDb;
  ownerId: string;
  secret: string;
  /** Platform-set caller IP (x-appwrite-client-ip); null outside a Function execution. */
  clientIp?: string | null;
}

const teamRead = (teamId: string) => [Permission.read(Role.team(teamId))];
const errorText = (err: unknown) => (err instanceof ServiceError ? `${err.mapped.kind}${err.mapped.type ? ` (${err.mapped.type})` : ''}: ${err.detail ?? err.mapped.message}` : err instanceof Error ? err.message : String(err));

// ---- registry and team -------------------------------------------------------------

async function ensureTeam(aw: ServerAppwrite, teamId: string, ownerId: string) {
  // Concurrent first requests (e.g. two tabs) may both get here: "already exists" means the other one won.
  const tolerateExisting = (err: unknown) => {
    if ((err as { code?: number }).code !== 409) throw err;
  };
  try {
    await aw.teams.get({ teamId });
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
    await aw.teams.create({ teamId, name: '[SYNTHETIC] Even Odds judge sandbox' }).catch(tolerateExisting);
  }
  const { memberships } = await aw.teams.listMemberships({ teamId, queries: [Query.equal('userId', ownerId), Query.limit(1)] });
  if (!memberships.some((m) => m.userId === ownerId)) await aw.teams.createMembership({ teamId, roles: ['organiser'], userId: ownerId }).catch(tolerateExisting);
}

async function createRegistryRow(c: SandboxCaller): Promise<Row<'sandboxes'>> {
  // Only RECENTLY active sandboxes count against the cap (Task 14): abandoned ones, which the
  // jobs Function removes after SANDBOX_IDLE_MS, must not lock new judges out. A hard ceiling
  // still bounds how many can exist at once.
  const serverTime = await serverNow(c.db);
  const activeSince = Query.greaterThan('last_active_at', new Date(serverTime.getTime() - SANDBOX_ACTIVE_MS).toISOString());
  const ipHash = c.clientIp ? clientIpHash(c.secret, c.clientIp) : null;
  const [active, all, fromIp] = await Promise.all([
    c.db.listRows('sandboxes', [activeSince, Query.limit(1)]),
    c.db.listRows('sandboxes', [Query.limit(1)]),
    ipHash ? c.db.listRows('sandboxes', [Query.equal('ip_hash', ipHash), activeSince, Query.limit(1)]) : Promise.resolve({ total: 0 }),
  ]);
  if (active.total >= MAX_SANDBOXES || all.total >= MAX_SANDBOXES * 3) throw new AppError('rate_limited', 'The demo is busy right now (too many active sandboxes). Please try again in a while.');
  // One network cannot hold the whole demo (Task 14). Generous enough for judges sharing a venue's connection.
  if (fromIp.total >= MAX_SANDBOXES_PER_IP) throw new AppError('rate_limited', `Too many demo sandboxes are open from your network (${String(MAX_SANDBOXES_PER_IP)}). Please use one you already have, or try again in half an hour.`);
  const now = serverTime.toISOString();
  try {
    return await c.db.createRow('sandboxes', sandboxRowId(c.ownerId), {
      owner_id: c.ownerId,
      team_id: `sbx${randomBytes(16).toString('hex')}`,
      program_id: sandboxProgramId(c.ownerId, 1),
      generation: 1,
      status: 'seeding',
      reset_count: 0,
      reset_window_start: now,
      last_active_at: now,
      ...(ipHash ? { ip_hash: ipHash } : {}),
    });
  } catch (err) {
    // A concurrent first request created it: use that one.
    if (!isKind(err, 'conflict')) throw err;
    return c.db.getRow('sandboxes', sandboxRowId(c.ownerId));
  }
}

/** The caller's sandbox program, re-checked as the caller's own demo program. */
async function ownProgram(c: SandboxCaller, sandbox: Row<'sandboxes'>): Promise<Row<'programs'>> {
  if (sandbox.owner_id !== c.ownerId) throw new AppError('not_found', 'Demo sandbox not found. Start a new demo.');
  const program = await findRow(c.db, 'programs', sandbox.program_id);
  if (!program) throw new AppError('not_found', 'Demo sandbox not found. Start a new demo.');
  assertSandboxOf(program, c.ownerId);
  return program;
}

/**
 * Opens (creating or finishing the seeding of) the caller's sandbox.
 * Idempotent: repeated or concurrent calls converge on one seeded program.
 */
export async function openSandbox(c: SandboxCaller): Promise<{ sandbox: Row<'sandboxes'>; program: Row<'programs'> }> {
  let sandbox = (await findRow(c.db, 'sandboxes', sandboxRowId(c.ownerId))) ?? (await createRegistryRow(c));
  if (sandbox.status === 'seeding') {
    await seedWithRetry(c, sandbox);
    sandbox = await c.db.updateRow('sandboxes', sandbox.$id, { status: 'ready' });
  } else if (Date.now() - Date.parse(sandbox.last_active_at) > 5 * 60_000) {
    sandbox = await c.db.updateRow('sandboxes', sandbox.$id, { last_active_at: new Date().toISOString() });
  }
  return { sandbox, program: await ownProgram(c, sandbox) };
}

/** The actor for console commands run inside the sandbox (the visitor, through the sandbox Team). */
export async function sandboxActor(c: SandboxCaller): Promise<ConsoleActor> {
  const { sandbox, program } = await openSandbox(c);
  return { program, actorId: c.ownerId, teamId: sandbox.team_id, scope: 'demo', users: c.aw.users };
}

// ---- seeding -----------------------------------------------------------------------

/**
 * Two first requests (two tabs, or React's development double effect) can seed the same
 * generation at once, and their bulk upserts then collide with `row_already_exists`.
 * Seeding is idempotent, so the request that lost simply runs it again: by then the
 * rows exist and the upserts update them.
 */
async function seedWithRetry(c: SandboxCaller, sandbox: Row<'sandboxes'>) {
  for (let attempt = 1; ; attempt++) {
    try {
      await seedGeneration(c, sandbox);
      return;
    } catch (err) {
      if (!isKind(err, 'conflict') || attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

/** Writes one generation's program and synthetic households. Every ID is deterministic, so a retry resumes. */
async function seedGeneration(c: SandboxCaller, sandbox: Row<'sandboxes'>) {
  const { db } = c;
  const programId = sandbox.program_id;
  const teamId = sandbox.team_id;
  await ensureTeam(c.aw, teamId, c.ownerId);
  const now = await serverNow(db);
  let program = await findRow(db, 'programs', programId);
  if (!program) {
    const details = programDetailsSchema.parse({
      name: DEMO_PROGRAM.name,
      description: DEMO_PROGRAM.description,
      timezone: DEMO_PROGRAM.timezone,
      windowOpen: new Date(now.getTime() - DEMO_PROGRAM.openedAgoMs).toISOString(),
      windowClose: new Date(now.getTime() + DEMO_PROGRAM.closesInMs).toISOString(),
      maxWeeks: DEMO_PROGRAM.maxWeeks,
      defaultTier: DEMO_PROGRAM.defaultTier,
      tierLabels: DEMO_PROGRAM.tierLabels,
    });
    // A concurrent request (two tabs, or a double effect in development) may create it first: use theirs.
    program = await createProgram(db, teamId, details, { programId, synthetic: true, sourceNote: DEMO_PROGRAM.sourceNote, sandboxOwner: c.ownerId }).catch(async (err: unknown) => {
      if (!isKind(err, 'conflict')) throw err;
      return db.getRow('programs', programId);
    });
  }
  assertSandboxOf(program, c.ownerId);
  if (program.status === 'draft') {
    await Promise.all([replaceSessions(db, teamId, programId, DEMO_SESSIONS, { scope: 'demo' }), replaceZones(db, teamId, programId, DEMO_ZONES, { scope: 'demo' })]);
    program = await publishProgram(db, teamId, programId, now, { scope: 'demo' }).catch(async (err: unknown) => {
      // Published by a concurrent seeding of the same generation.
      const latest = await db.getRow('programs', programId);
      if (latest.status === 'draft') throw err;
      return latest;
    });
  }
  // Odds for the sandbox are left to the hourly jobs run: the Monte Carlo would not fit this request's time limit.
  if (program.status === 'open') await seedHouseholds(c, program, teamId);
}

async function seedHouseholds(c: SandboxCaller, program: Row<'programs'>, teamId: string) {
  const { db } = c;
  const programId = program.$id;
  const sessions = await allRows(db, 'seat_ledger', [Query.equal('program_id', programId)]);
  const opened = Date.parse(program.window_open);
  const team = teamRead(teamId);
  type Bulk = Record<'families' | 'family_locations' | 'children' | 'tickets' | 'applications' | 'preferences', Record<string, unknown>[]>;
  const bulk: Bulk = { families: [], family_locations: [], children: [], tickets: [], applications: [], preferences: [] };

  // Tiers come from the same server-side geo classification (Query.intersects / distanceLessThan) real families get.
  const tiers = await Promise.all(DEMO_FAMILIES.map((f) => classifyPoint(db, program, f.home)));
  for (const [n, f] of DEMO_FAMILIES.entries()) {
    const familyId = sandboxFamilyId(programId, f.key);
    bulk.families.push({ $id: familyId, $permissions: [], created_by: programId, synthetic: true });
    bulk.family_locations.push({ $id: locationRowId(familyId), $permissions: [], family_id: familyId, home: f.home });
    bulk.applications.push({
      $id: applicationRowId(programId, familyId),
      $permissions: team,
      program_id: programId,
      family_id: familyId,
      public_id: demoPublicId(programId, f.key),
      claimed_tier: tiers[n]?.tier ?? DEMO_PROGRAM.defaultTier,
      near_boundary: tiers[n]?.nearBoundary ?? false,
      sibling_mode: f.siblingMode,
      status: 'submitted',
      submitted_at: new Date(opened + f.appliedAfterHours * 3600_000).toISOString(),
      late: false,
      synthetic: true,
    });
    for (const [i, k] of f.children.entries()) {
      const childId = sandboxChildId(programId, f.key, i);
      const child = { family_id: familyId, first_name: syntheticName(k.firstName), last_name: k.lastName, birthdate: `${k.birthdate}T00:00:00.000Z` };
      const eligible = new Map(weeksForChild(child.birthdate, sessions).map((w) => [w.week, w.ageGroup]));
      bulk.children.push({ $id: childId, $permissions: [], ...child });
      bulk.tickets.push({ $id: ticketRowId(programId, childId), $permissions: team, program_id: programId, child_id: childId, family_id: familyId, child_key: childKey(c.secret, { programId, firstName: child.first_name, lastName: k.lastName, birthdate: k.birthdate }) });
      bulk.preferences.push({
        $id: preferenceRowId(programId, childId),
        $permissions: team,
        program_id: programId,
        family_id: familyId,
        child_id: childId,
        ranked_weeks: k.rankedWeeks,
        ranked_age_groups: k.rankedWeeks.map((w) => eligible.get(w) ?? ''),
        requested_weeks: k.requested,
      });
    }
  }
  const probeId = sandboxFamilyId(programId, DEMO_ROLLBACK_FAMILY.key);
  bulk.families.push({ $id: probeId, $permissions: [], created_by: programId, synthetic: true });
  DEMO_ROLLBACK_FAMILY.children.forEach((k, i) => {
    bulk.children.push({ $id: sandboxChildId(programId, DEMO_ROLLBACK_FAMILY.key, i), $permissions: [], family_id: probeId, first_name: syntheticName(k.firstName), last_name: k.lastName, birthdate: `${k.birthdate}T00:00:00.000Z` });
  });
  // Bulk upserts (each well under 100 rows), households first, then their program entries.
  const write = async (table: keyof Bulk) => {
    for (let i = 0; i < bulk[table].length; i += 100) await db.upsertRows(table, bulk[table].slice(i, i + 100) as never);
  };
  await Promise.all((['families', 'family_locations', 'children'] as const).map(write));
  await Promise.all((['tickets', 'applications', 'preferences'] as const).map(write));
}

// ---- deletion (sandbox generations only) ---------------------------------------------

/** Every table whose rows carry the program ID. */
const PROGRAM_TABLES: readonly TableKey[] = [
  'placements', 'waitlist', 'preferences', 'applications', 'tickets', 'link_requests', 'overrides', 'staff_actions',
  'offer_stats', 'odds_snapshots', 'frozen_inputs', 'draw_results', 'draw_runs', 'idempotency', 'audit_log', 'zones', 'seat_ledger',
];

async function deleteAll(db: ServerDb, table: TableKey, queries: string[]) {
  for (let i = 0; i < 100; i++) {
    const { total } = await db.listRows(table, [...queries, Query.limit(1)]);
    if (total === 0) return;
    await db.deleteRowsWhere(table, queries);
  }
}

/**
 * Deletes one sandbox generation. Refuses anything that is not a demo
 * program of `ownerId`; production rows are never reachable from here. The
 * program row goes last, so an interrupted deletion is finished next time.
 * The sandbox's audit chain is discarded with it (production chains never
 * are: production programs cannot reach this function).
 */
async function deleteGeneration(db: ServerDb, ownerId: string, program: Row<'programs'>, deadline = Number.POSITIVE_INFINITY): Promise<boolean> {
  assertSandboxOf(program, ownerId);
  const scoped = [Query.equal('program_id', program.$id)];
  // Four tables at a time; stop between waves when the time budget is spent (the next call resumes).
  for (let i = 0; i < PROGRAM_TABLES.length; i += 4) {
    if (Date.now() > deadline) return false;
    await Promise.all(PROGRAM_TABLES.slice(i, i + 4).map((table) => deleteAll(db, table, scoped)));
  }
  if (Date.now() > deadline) return false;
  const households = await allRows(db, 'families', [Query.equal('created_by', program.$id)]);
  for (let i = 0; i < households.length; i += 50) {
    const ids = households.slice(i, i + 50).map((f) => f.$id);
    await Promise.all([deleteAll(db, 'children', [Query.equal('family_id', ids)]), deleteAll(db, 'family_locations', [Query.equal('family_id', ids)])]);
  }
  await deleteAll(db, 'families', [Query.equal('created_by', program.$id), Query.equal('synthetic', true)]);
  await db.deleteRow('programs', program.$id);
  return true;
}

/** Deletes the visitor's other sandbox generations within `deadline`; whatever is left is finished on a later call. */
async function deleteGenerationsExcept(db: ServerDb, ownerId: string, keep: string | null, deadline = Number.POSITIVE_INFINITY) {
  const programs = (await allRows(db, 'programs', [Query.equal('sandbox_owner', ownerId), Query.equal('namespace', 'demo')])).filter((p) => p.$id !== keep);
  let removed = 0;
  for (const p of programs) if (await deleteGeneration(db, ownerId, p, deadline)) removed++;
  return { removed, pending: programs.length - removed };
}

/**
 * Reset: restores the seeded scenario in a NEW generation (fresh program
 * ID), then deletes the old one. Idempotent per request key: a retried reset
 * returns the same generation instead of starting another.
 */
export async function resetSandbox(c: SandboxCaller, idempotencyKey: string) {
  const { db } = c;
  const started = Date.now();
  const existing = await findRow(db, 'sandboxes', sandboxRowId(c.ownerId));
  if (!existing) {
    const opened = await openSandbox(c);
    return { status: 'created' as const, generation: opened.sandbox.generation, programId: opened.program.$id, removed: 0 };
  }
  const keyRow = deterministicId('ik', 'sandbox-reset', c.ownerId, idempotencyKey);
  const earlier = await findRow(db, 'idempotency', keyRow);
  if (earlier) {
    const opened = await openSandbox(c);
    return { status: 'replayed' as const, generation: opened.sandbox.generation, programId: opened.program.$id, removed: 0 };
  }
  let current = existing;
  for (let attempt = 1; ; attempt++) {
    const now = await serverNow(db);
    const windowFresh = now.getTime() - Date.parse(current.reset_window_start) < 3600_000;
    if (windowFresh && current.reset_count >= RESETS_PER_HOUR) throw new AppError('rate_limited', `You can reset the sandbox ${String(RESETS_PER_HOUR)} times an hour. Please wait a few minutes.`);
    const generation = current.generation + 1;
    const programId = sandboxProgramId(c.ownerId, generation);
    const tx = await db.transactions.begin(60);
    try {
      await db.updateRow(
        'sandboxes',
        current.$id,
        {
          generation,
          program_id: programId,
          status: 'seeding',
          reset_count: windowFresh ? current.reset_count + 1 : 1,
          reset_window_start: windowFresh ? current.reset_window_start : now.toISOString(),
          last_active_at: now.toISOString(),
        },
        { transactionId: tx.$id },
      );
      // One generation bump per (owner, generation): a concurrent reset collides here and adopts the winner.
      await db.createRow('idempotency', deterministicId('ik', 'sandbox-generation', c.ownerId, String(generation)), { scope: 'sandbox-gen', program_id: programId, key_hash: sha256Hex(`${c.ownerId}:${String(generation)}`) }, { transactionId: tx.$id });
      await db.createRow('idempotency', keyRow, { scope: 'sandbox-reset', program_id: programId, key_hash: sha256Hex(idempotencyKey), result: JSON.stringify({ generation }) }, { transactionId: tx.$id });
    } catch (err) {
      await db.transactions.rollback(tx.$id).catch(() => undefined);
      throw err;
    }
    try {
      await db.transactions.commit(tx.$id);
      break;
    } catch (err) {
      if (!isKind(err, 'transaction_conflict', 'conflict')) throw err;
      const latest = await db.getRow('sandboxes', current.$id);
      // Another reset moved to a new generation: adopt it. Otherwise (e.g. an activity touch raced us) try again.
      if (latest.generation > current.generation || attempt >= 4) break;
      current = latest;
    }
  }
  const opened = await openSandbox(c);
  // The old generation is deleted within what is left of this request's time; status calls (and the hourly job) finish it.
  const { removed, pending } = await deleteGenerationsExcept(db, c.ownerId, opened.program.$id, started + 20_000);
  return { status: 'reset' as const, generation: opened.sandbox.generation, programId: opened.program.$id, removed, pendingCleanup: pending };
}

/** Removes one visitor's sandbox entirely: every generation's rows, its Team and its registry row. */
export async function destroySandbox(aw: ServerAppwrite, db: ServerDb, ownerId: string) {
  const sandbox = await findRow(db, 'sandboxes', sandboxRowId(ownerId));
  const { removed: programs } = await deleteGenerationsExcept(db, ownerId, null);
  if (sandbox) {
    await aw.teams.delete({ teamId: sandbox.team_id }).catch(() => undefined);
    await db.deleteRow('sandboxes', sandbox.$id);
  }
  return { programs };
}

/** jobs Function: removes sandboxes idle for 24 h (their programs, rows and Team). */
export async function removeIdleSandboxes(aw: ServerAppwrite, db: ServerDb, now = new Date()) {
  const idle = await db.listRows('sandboxes', [Query.lessThan('last_active_at', new Date(now.getTime() - SANDBOX_IDLE_MS).toISOString()), Query.limit(5)]);
  for (const s of idle.rows) await destroySandbox(aw, db, s.owner_id);
  return { removed: idle.rows.length };
}

// ---- status and guide ----------------------------------------------------------------

export async function sandboxStatus(c: SandboxCaller) {
  const started = Date.now();
  const { sandbox, program } = await openSandbox(c);
  const { db } = c;
  // Finish deleting earlier generations left over from a reset (bounded; never the current one).
  const leftovers = await deleteGenerationsExcept(db, c.ownerId, program.$id, started + 12_000);
  const scope = [Query.equal('program_id', program.$id)];
  const [apps, placements, waits, ledgers, draw] = await Promise.all([
    allRows(db, 'applications', scope),
    allRows(db, 'placements', scope),
    allRows(db, 'waitlist', scope),
    allRows(db, 'seat_ledger', scope),
    drawStatus(db, program),
  ]);
  const byFamily = new Map(apps.map((a) => [a.family_id, a]));
  const tierLabels = JSON.parse(program.tier_labels ?? '{}') as Record<string, string>;
  const families = DEMO_FAMILIES.map((f) => {
    const familyId = sandboxFamilyId(program.$id, f.key);
    const app = byFamily.get(familyId);
    const mine = placements.filter((p) => p.family_id === familyId);
    const tier = app ? (app.verified_tier ?? app.claimed_tier ?? null) : null;
    return {
      key: f.key,
      label: f.label,
      publicId: app?.public_id ?? null,
      children: f.children.map((k) => ({ name: syntheticName(`${k.firstName} ${k.lastName}`), ranked: k.rankedWeeks, requested: k.requested })),
      siblingMode: f.siblingMode,
      tier,
      tierLabel: tier === null ? null : (tierLabels[String(tier)] ?? `Tier ${String(tier)}`),
      nearBoundary: app?.near_boundary ?? false,
      submittedAt: app?.submitted_at ? new Date(app.submitted_at).toISOString() : null,
      note: f.note ?? null,
      offers: mine.map((p) => ({ placementId: p.$id, week: p.week, ageGroup: p.age_group, status: p.status, expiresAt: p.expires_at ? new Date(p.expires_at).toISOString() : null, source: p.source ?? 'draw' })),
      waiting: waits.filter((w) => w.family_id === familyId && w.status === 'waiting').length,
    };
  });
  const own = apps.filter((a) => !a.synthetic);
  return {
    scenario: DEMO_SCENARIO_VERSION,
    generation: sandbox.generation,
    program: {
      id: program.$id,
      name: program.name,
      status: program.status,
      timezone: program.timezone,
      windowOpen: new Date(program.window_open).toISOString(),
      windowClose: new Date(program.window_close).toISOString(),
      demoAdvancedMs: program.demo_advanced_ms ?? 0,
      offersIssuedAt: program.offers_issued_at ? new Date(program.offers_issued_at).toISOString() : null,
    },
    timing: TIMING.demo,
    draw,
    sessions: ledgers
      .sort((a, b) => a.week_start.localeCompare(b.week_start) || a.min_age - b.min_age)
      .map((l) => ({ ledgerId: l.$id, week: l.week, label: l.label ?? l.week, ageGroup: l.age_group, capacity: l.capacity, taken: l.taken })),
    families,
    ownApplications: own.length,
    cleanupPending: leftovers.pending,
    duplicateHint: { firstName: syntheticName(DEMO_DUPLICATE_CHILD.firstName), lastName: DEMO_DUPLICATE_CHILD.lastName, birthdate: DEMO_DUPLICATE_CHILD.birthdate },
    rollbackFamily: { label: DEMO_ROLLBACK_FAMILY.label, children: DEMO_ROLLBACK_FAMILY.children.map((k) => ({ name: syntheticName(`${k.firstName} ${k.lastName}`), ageGroup: k.ageGroup })) },
  };
}

// ---- demo time -----------------------------------------------------------------------

/**
 * Fast-forward to the close, then freeze. Moves this sandbox's window so it
 * closed one second ago (by the Appwrite server clock), announces the round
 * the demo timing rule gives for that close (still in the future), and runs
 * the real freeze. Production programs announce their round at publish; a
 * sandbox's window is not fixed in advance, so its round is announced here,
 * before its inputs are frozen and before that round exists.
 */
export async function closeApplications(c: SandboxCaller) {
  const actor = await sandboxActor(c);
  const { db } = c;
  let { program } = actor;
  const steps: InspectorStep[] = [];
  if (program.status !== 'open') {
    const freeze = await freezeProgram(db, program.$id);
    steps.push({ op: 'freeze', detail: `Already frozen: inputs hash ${freeze.inputsHash.slice(0, 16)}…`, outcome: 'info' });
    return { status: 'already_frozen' as const, freeze, steps };
  }
  const now = await serverNow(db);
  let advancedMs = 0;
  if (program.drand_round === null || program.drand_round === undefined) {
    const close = Date.parse(program.window_close);
    advancedMs = Math.max(0, close - now.getTime()) + 1000;
    const windowClose = new Date(close - advancedMs).toISOString();
    const windowOpen = new Date(Date.parse(program.window_open) - advancedMs).toISOString();
    const round = announcedRound(windowClose, 'demo');
    const roundAt = new Date(roundTimeMs(round)).toISOString();
    const total = (program.demo_advanced_ms ?? 0) + advancedMs;
    await privileged(
      db,
      actor,
      {
        action: 'demo_time_advanced',
        event: 'drand_round_announced',
        idempotencyKey: `close:${program.$id}`,
        detail: { drand_chain: DRAND_CHAIN.hash, drand_round: round, drand_round_at: roundAt, rule: 'demo timing: first round at or after window_close + 45 s', window_close: windowClose, demo_advanced_ms: advancedMs },
      },
      (transactionId) => db.updateRow('programs', program.$id, { window_open: windowOpen, window_close: windowClose, drand_round: round, drand_chain: DRAND_CHAIN.hash, demo_advanced_ms: total }, { transactionId }).then(() => undefined),
    );
    steps.push({ op: 'demo clock', detail: `Moved this sandbox's window ${formatSpan(advancedMs)} earlier: applications closed at ${windowClose} (server time). No clock was changed.`, outcome: 'info' });
    steps.push({ op: 'announce', detail: `drand round ${String(round)} announced (due ${roundAt}). It does not exist yet, so nobody can know it.`, outcome: 'ok' });
    program = await db.getRow('programs', program.$id);
  }
  const freeze = await freezeProgram(db, program.$id, { now: await serverNow(db) });
  steps.push({ op: 'transaction', detail: `Freeze committed in ONE transaction: program open → frozen, frozen_inputs snapshot, pending draw run, audit entry "inputs_frozen".`, outcome: 'ok' });
  steps.push({ op: 'hash', detail: `Inputs hash ${freeze.inputsHash} over ${String(freeze.counts.applications)} applications, ${String(freeze.counts.children)} children, ${String(freeze.counts.seats)} seats, ${String(freeze.counts.overrides)} overrides.`, outcome: 'ok' });
  await logStaffAction(db, actor, { action: 'inputs_frozen', key: `freeze:${program.$id}`, detail: { inputs_hash: freeze.inputsHash, drand_round: freeze.drandRound } });
  return { status: freeze.status, freeze, advancedMs, steps };
}

const formatSpan = (ms: number) => {
  const h = Math.floor(ms / 3600_000);
  const d = Math.floor(h / 24);
  return d > 0 ? `${String(d)} d ${String(h % 24)} h` : `${String(h)} h ${String(Math.round((ms % 3600_000) / 60_000))} min`;
};

/**
 * Runs the draw as far as the time budget allows, through the same
 * advanceDraw() the hourly job uses. Before the announced round exists it
 * returns "waiting" with the round time; the UI waits and calls again.
 */
export async function runSandboxDraw(c: SandboxCaller) {
  const actor = await sandboxActor(c);
  const { db } = c;
  const { program } = actor;
  if (program.status === 'open' || program.status === 'draft') throw new AppError('locked', 'Fast-forward to the close first: the draw needs frozen inputs.');
  const steps: InspectorStep[] = [];
  let outcome: unknown = null;
  if (program.status === 'frozen') {
    const result = await advanceDraw(db, protocolDrawRunId(program.$id), { budgetMs: DRAW_BUDGET_MS, concurrency: 6 });
    outcome = result;
    if (result.status === 'pending') {
      const beacon = result.beacon;
      steps.push({ op: 'drand', detail: beacon.status === 'waiting' ? `Round ${String(beacon.round)} is due ${beacon.roundAt}; the draw cannot start before it exists.` : `Beacon not available yet: ${'detail' in beacon ? beacon.detail : beacon.status}`, outcome: 'info' });
    } else if (result.status === 'running') {
      steps.push({ op: 'draw', detail: `Committed ${String(result.cursor)} of ${String(result.total)} plan steps (one transaction each); continuing.`, outcome: 'ok' });
    } else if (result.status === 'completed') {
      steps.push({ op: 'draw', detail: `Draw committed: ${String(result.placements)} placements, ${String(result.waitlist)} waitlist entries. Offers issued with a 48 h clock.`, outcome: 'ok' });
      await logStaffAction(db, actor, { action: 'draw_run', key: `draw:${program.$id}`, detail: { placements: result.placements, waitlist: result.waitlist } });
    } else {
      steps.push({ op: 'draw', detail: `Stopped: ${'reason' in result ? result.reason : result.error}`, outcome: 'refused' });
    }
  } else if (!program.offers_issued_at) {
    outcome = await issueOffers(db, program.$id);
  }
  const status = await drawStatus(db, await db.getRow('programs', program.$id));
  if (status.run?.seed && !steps.some((s) => s.op === 'drand')) {
    steps.unshift({ op: 'drand', detail: `Beacon for round ${String(status.drandRound)} fetched and its BLS signature verified against the pinned quicknet key; seed ${status.run.seed.slice(0, 16)}… derived from it and the inputs hash.`, outcome: 'ok' });
  }
  return { outcome, status, steps };
}

/**
 * Fast-forward 48 hours for offers: moves every pending offer's clock (and
 * the program's issue time) back by exactly 48 h, in one transaction with
 * its log, then runs the real sweep: expiry is decided by Appwrite server
 * time against expires_at, and released seats go to the waitlist in lottery
 * order inside transactions.
 */
export async function expireSandboxOffers(c: SandboxCaller) {
  const actor = await sandboxActor(c);
  const { db } = c;
  const { program } = actor;
  if (program.status !== 'drawn' || !program.offers_issued_at) throw new AppError('locked', 'Run the draw first: there are no offers to expire yet.');
  const pending = await allRows(db, 'placements', [Query.equal('program_id', program.$id), Query.equal('status', 'offered')]);
  const shift = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) - OFFER_JUMP_MS).toISOString() : null);
  // Offers made together share one clock, so a few bulk updates (one per distinct expiry) move them all.
  const clocks = new Map<string, Row<'placements'>>();
  for (const p of pending) if (p.expires_at && !clocks.has(p.expires_at)) clocks.set(p.expires_at, p);
  for (const [expiresAt, p] of clocks) {
    await db.updateRowsWhere('placements', { expires_at: shift(expiresAt), offered_at: shift(p.offered_at) }, [Query.equal('program_id', program.$id), Query.equal('status', 'offered'), Query.equal('expires_at', expiresAt)]);
  }
  await privileged(
    db,
    actor,
    { action: 'demo_time_advanced', event: 'demo_time_advanced', idempotencyKey: `offers:${program.$id}:${String(program.demo_advanced_ms ?? 0)}`, detail: { demo_advanced_ms: OFFER_JUMP_MS, offers_moved: pending.length, what: 'pending offer clocks moved 48 h earlier' } },
    (transactionId) => db.updateRow('programs', program.$id, { offers_issued_at: shift(program.offers_issued_at), demo_advanced_ms: (program.demo_advanced_ms ?? 0) + OFFER_JUMP_MS }, { transactionId }).then(() => undefined),
  );
  const sweep = await runOfferSweep(db, { deadline: Date.now() + SWEEP_BUDGET_MS, programId: program.$id });
  const steps: InspectorStep[] = [
    { op: 'demo clock', detail: `Moved ${String(pending.length)} pending offer clock(s) 48 h earlier. No clock was changed.`, outcome: 'info' },
    { op: 'expiry', detail: `${String(sweep.expired)} offer(s) expired: each one a transaction that marks it expired, releases its seat (decrementRowColumn, min 0) and records a one-time exit marker.`, outcome: 'ok' },
    { op: 'waitlist', detail: `${String(sweep.promoted)} place(s) offered from the waitlist in strict lottery order (capped increment, together-only siblings all or nothing).`, outcome: 'ok' },
  ];
  if (sweep.more) steps.push({ op: 'sweep', detail: 'More offers remain; the console keeps processing them with the same sweep the hourly job runs.', outcome: 'info' });
  return { sweep, steps };
}

// ---- synthetic families reply --------------------------------------------------------

export async function respondAsSynthetic(c: SandboxCaller, req: { publicId: string; response: OfferResponse }) {
  const actor = await sandboxActor(c);
  const { db } = c;
  const { program } = actor;
  const { rows } = await db.listRows('applications', [Query.equal('program_id', program.$id), Query.equal('public_id', req.publicId), Query.limit(1)]);
  const app = rows[0];
  const household = app ? await findRow(db, 'families', app.family_id) : null;
  if (!app || household?.created_by !== program.$id || !household.synthetic) {
    throw new AppError('forbidden', 'Demo controls can only reply for the synthetic households. Reply to your own offers from My offers.');
  }
  const from = req.response === 'giveBack' ? 'accepted' : 'offered';
  const placements = await allRows(db, 'placements', [Query.equal('program_id', program.$id), Query.equal('family_id', app.family_id), Query.equal('status', from)]);
  if (placements.length === 0) throw new AppError('conflict', req.response === 'giveBack' ? 'This household has no accepted place to give back.' : 'This household has no pending offer.');
  const result = await respondForHousehold(db, app.family_id, { programId: program.$id, placementIds: placements.map((p) => p.$id), response: req.response, idempotencyKey: `demo-${randomBytes(12).toString('hex')}` });
  return {
    result,
    steps: [
      { op: 'transaction', detail: `${String(placements.length)} offer(s) moved ${from} → ${req.response === 'accept' ? 'accepted' : req.response === 'decline' ? 'declined' : 'released'} in one transaction, checked against Appwrite server time.`, outcome: 'ok' as const },
      ...(result.promoted > 0 ? [{ op: 'waitlist', detail: `${String(result.promoted)} released place(s) offered to the next child in lottery order.`, outcome: 'ok' as const }] : []),
    ],
  };
}

// ---- demonstrations ------------------------------------------------------------------

/**
 * "Two parents, one ticket": a SECOND synthetic household registers the
 * Rivera household's Maya for this program. The unique index on
 * tickets(program_id, child_key) refuses the second ticket; the product path
 * (ensureTicket) then raises a link request to the existing household,
 * without revealing anything to the requester.
 */
export async function duplicateChildDemo(c: SandboxCaller) {
  const actor = await sandboxActor(c);
  const { db } = c;
  const { program } = actor;
  if (program.status !== 'open') throw new AppError('locked', 'Applications are frozen; reset the sandbox to try the duplicate-child demonstration again.');
  const steps: InspectorStep[] = [];
  const familyId = sandboxFamilyId(program.$id, SECOND_GUARDIAN_KEY);
  const childId = sandboxChildId(program.$id, SECOND_GUARDIAN_KEY, 0);
  await db.upsertRows('families', [{ $id: familyId, $permissions: [], created_by: program.$id, synthetic: true }]);
  const child = await db.upsertRow('children', childId, { family_id: familyId, first_name: syntheticName(DEMO_DUPLICATE_CHILD.firstName), last_name: DEMO_DUPLICATE_CHILD.lastName, birthdate: `${DEMO_DUPLICATE_CHILD.birthdate}T00:00:00.000Z` });
  steps.push({ op: 'household', detail: `A second synthetic household adds "${child.first_name} ${child.last_name}", born ${DEMO_DUPLICATE_CHILD.birthdate}, the same child the Rivera household already entered.`, outcome: 'info' });
  const key = childKey(c.secret, { programId: program.$id, firstName: child.first_name, lastName: child.last_name, birthdate: DEMO_DUPLICATE_CHILD.birthdate });
  steps.push({ op: 'child_key', detail: `child_key = HMAC-SHA256(server secret, normalised name + birthdate + program) = ${key.slice(0, 16)}… (case, accents and punctuation are ignored).`, outcome: 'info' });
  try {
    await db.createRow('tickets', ticketRowId(program.$id, childId), { program_id: program.$id, child_id: childId, family_id: familyId, child_key: key }, { permissions: teamRead(actor.teamId) });
    steps.push({ op: 'createRow(tickets)', detail: 'Unexpected: the database accepted a second ticket.', outcome: 'refused' });
  } catch (err) {
    steps.push({ op: 'createRow(tickets)', detail: `Refused by the unique index uq_program_child_key → ${errorText(err)}`, outcome: 'refused' });
  }
  const outcome = await ensureTicket(db, c.secret, { familyId, guardianIds: [] }, program, child);
  const { total } = await db.listRows('tickets', [Query.equal('program_id', program.$id), Query.equal('child_key', key), Query.limit(1)]);
  steps.push({ op: 'product path', detail: `ensureTicket() answers "${outcome.status}" and tells the requester nothing about the other household.`, outcome: 'ok' });
  const requests = await db.listRows('link_requests', [Query.equal('program_id', program.$id), Query.equal('family_id', sandboxFamilyId(program.$id, DEMO_DUPLICATE_CHILD.familyKey)), Query.limit(5)]);
  steps.push({ op: 'link request', detail: `The Rivera household now has ${String(requests.total)} open link request(s), so its guardian can invite the second parent instead.`, outcome: 'ok' });
  steps.push({ op: 'invariant', detail: `Tickets for this child in this program: ${String(total)}.`, outcome: total === 1 ? 'ok' : 'refused' });
  return { outcome: outcome.status, ticketsForChild: total, linkRequests: requests.total, steps };
}

/**
 * "The database refused": a sibling pair in two age groups tries to take a
 * week in which one group is full. Both capped increments are staged in one
 * transaction; the commit is refused and NOTHING is kept, including the
 * seat that did fit. Allowed only after the draw (so a full session exists
 * and the attempt cannot take a seat from the lottery); if a seat freed up
 * in the meantime and the attempt commits, it is undone and reported.
 */
export async function rollbackDemo(c: SandboxCaller) {
  const actor = await sandboxActor(c);
  const { db } = c;
  const { program } = actor;
  if (program.status !== 'drawn') throw new AppError('locked', 'Run the draw first: the rollback demonstration needs a full session.');
  const ledgers = await allRows(db, 'seat_ledger', [Query.equal('program_id', program.$id)]);
  const [young, old] = DEMO_ROLLBACK_FAMILY.children;
  const at = (week: string, ageGroup: string) => ledgers.find((l) => l.week === week && l.age_group === ageGroup);
  const weeks = [...new Set(ledgers.map((l) => l.week))].sort();
  const pick =
    weeks.find((w) => { const a = at(w, young.ageGroup); const b = at(w, old.ageGroup); return a && b && ((b.taken >= b.capacity && a.taken < a.capacity) || (a.taken >= a.capacity && b.taken < b.capacity)); }) ??
    weeks.find((w) => { const a = at(w, young.ageGroup); const b = at(w, old.ageGroup); return a && b && (a.taken >= a.capacity || b.taken >= b.capacity); });
  if (!pick) throw new AppError('conflict', 'No session is full right now (offers were released), so there is nothing to refuse. Reset the sandbox to see it again.');
  const familyId = sandboxFamilyId(program.$id, DEMO_ROLLBACK_FAMILY.key);
  const members = DEMO_ROLLBACK_FAMILY.children.map((k, i) => ({ childId: sandboxChildId(program.$id, DEMO_ROLLBACK_FAMILY.key, i), ageGroup: k.ageGroup, ledger: at(pick, k.ageGroup) as Row<'seat_ledger'> }));
  const before = members.map((m) => `${m.ageGroup} ${String(m.ledger.taken)}/${String(m.ledger.capacity)}`).join(', ');
  const label = members[0]?.ledger.label ?? pick;
  const steps: InspectorStep[] = [{ op: 'read', detail: `${label}: seats taken ${before}.`, outcome: 'info' }];

  const tx = await db.transactions.begin(60);
  steps.push({ op: 'createTransaction', detail: `Transaction ${tx.$id} opened.`, outcome: 'info' });
  let committed = false;
  try {
    for (const m of members) {
      await db.incrementRowColumn('seat_ledger', m.ledger.$id, 'taken', { value: 1, max: m.ledger.capacity, transactionId: tx.$id });
      steps.push({ op: 'incrementRowColumn', detail: `seat_ledger ${pick}/${m.ageGroup}: taken +1, max = ${String(m.ledger.capacity)} (staged).`, outcome: 'info' });
    }
    for (const m of members) {
      await db.createRow('placements', deterministicId('pl', 'rollback-demo', program.$id, m.childId, pick), { program_id: program.$id, child_id: m.childId, family_id: familyId, ledger_id: m.ledger.$id, week: pick, age_group: m.ageGroup, status: 'offered' }, { permissions: teamRead(actor.teamId), transactionId: tx.$id });
    }
    steps.push({ op: 'createRow(placements)', detail: `${String(members.length)} placement rows (one per sibling) staged in the same transaction.`, outcome: 'info' });
    await db.transactions.commit(tx.$id);
    committed = true;
  } catch (err) {
    await db.transactions.rollback(tx.$id).catch(() => undefined);
    steps.push({ op: 'commit', detail: `Refused → ${errorText(err)}. The whole transaction was rolled back: both increments and both placements.`, outcome: 'refused' });
  }
  if (committed) {
    // A seat freed up between the check and the commit: undo it so the demonstration never takes a lottery seat.
    const undo = await db.transactions.begin(60);
    for (const m of members) {
      await db.deleteRow('placements', deterministicId('pl', 'rollback-demo', program.$id, m.childId, pick), undo.$id);
      await db.decrementRowColumn('seat_ledger', m.ledger.$id, 'taken', { value: 1, min: 0, transactionId: undo.$id });
    }
    await db.transactions.commit(undo.$id);
    steps.push({ op: 'commit', detail: 'The database ACCEPTED it: a seat had just been released. The demonstration undid its own placement; try again once the session is full.', outcome: 'info' });
  }
  const after = await Promise.all(members.map((m) => db.getRow('seat_ledger', m.ledger.$id)));
  const rows = await Promise.all(members.map((m) => findRow(db, 'placements', deterministicId('pl', 'rollback-demo', program.$id, m.childId, pick))));
  steps.push({ op: 're-read', detail: `${label}: seats taken ${after.map((l) => `${l.age_group} ${String(l.taken)}/${String(l.capacity)}`).join(', ')}. Placement rows for the Brooks children: ${String(rows.filter(Boolean).length)}.`, outcome: rows.some(Boolean) ? 'refused' : 'ok' });
  return { week: pick, refused: !committed, before: members.map((m) => ({ ageGroup: m.ageGroup, taken: m.ledger.taken, capacity: m.ledger.capacity })), after: after.map((l) => ({ ageGroup: l.age_group, taken: l.taken, capacity: l.capacity })), steps };
}

