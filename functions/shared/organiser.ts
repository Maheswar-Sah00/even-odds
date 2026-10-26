import { Permission, Query, Role, type Teams } from 'node-appwrite';
import { canonicalJson } from './crypto.ts';
import { announcedRound, DRAND_CHAIN, roundTimeMs } from '../../shared/freeze/protocol.ts';
import { classify, type Classification, type LngLat, type Polygon } from '../../shared/geo.ts';
import { programDetailsSchema, type ProgramDetails, type SessionRow, type ZoneInput } from '../../shared/program-input.ts';
import { AppError } from './app-error.ts';
import { ServiceError } from '../../shared/errors.ts';
import { prepareAudit } from './audit.ts';
import { deterministicId, sha256Hex } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { assertScope, isDemo, type Scope } from './namespace.ts';
import { transitionProgram } from './program-status.ts';
import { sleepBackoff } from './retry.ts';

/**
 * Organiser configuration. Every entry point re-checks that the caller is a
 * confirmed member of the program's organiser Team. Clients hold no write
 * permissions; this is the only path that changes catalogue data.
 *
 * Lifecycle: draft (organisers only) -> open (published: anyone can read the
 * program, its sessions and zones). Structure (window, sessions, zones,
 * tiers) is editable only while draft; capacity can be raised later but never
 * below seats already taken.
 */

export const ledgerRowId = (programId: string, week: string, ageGroup: string) => deterministicId('sl', 'ledger', programId, week, ageGroup);
export const zoneRowId = (programId: string, index: number) => deterministicId('zn', 'zone', programId, String(index));

const teamRead = (teamId: string) => [Permission.read(Role.team(teamId))];
const published = (teamId: string) => [Permission.read(Role.any()), Permission.read(Role.team(teamId))];

export async function requireOrganiser(teams: Teams, teamId: string, userId: string): Promise<void> {
  const { memberships } = await teams.listMemberships({ teamId, queries: [Query.equal('userId', userId), Query.limit(1)] }).catch(() => ({ memberships: [] }));
  if (!memberships.some((m) => m.userId === userId && m.confirm)) throw new AppError('forbidden', 'Only organisers can change program configuration.');
}

/**
 * `scope` is "production" for every organiser request; only judge-sandbox
 * seeding (functions/shared/sandbox.ts) passes "demo". Each scope sees only
 * its own programs (functions/shared/namespace.ts).
 */
export interface ScopeOption {
  scope?: Scope;
}

async function loadProgram(db: ServerDb, programId: string, teamId: string, scope: Scope = 'production'): Promise<Row<'programs'>> {
  const program = await db.getRow('programs', programId).catch(() => null);
  // Programs of other organiser teams look like they do not exist.
  if (!program || program.org_team_id !== teamId) throw new AppError('not_found', 'Program not found.');
  assertScope(program, scope);
  return program;
}

function requireDraft(p: Row<'programs'>) {
  if (p.status !== 'draft') throw new AppError('locked', 'This program is published; its structure can no longer change.');
}

const detailsToRow = (d: ProgramDetails) => ({
  name: d.name,
  description: d.description,
  timezone: d.timezone,
  window_open: new Date(d.windowOpen).toISOString(),
  window_close: new Date(d.windowClose).toISOString(),
  max_weeks: d.maxWeeks,
  default_tier: d.defaultTier,
  tier_labels: JSON.stringify(d.tierLabels),
});

export async function createProgram(
  db: ServerDb,
  teamId: string,
  details: ProgramDetails,
  opts: { programId: string; synthetic?: boolean; sourceNote?: string; /** Demo sandboxes only (functions/shared/sandbox.ts). */ sandboxOwner?: string },
): Promise<Row<'programs'>> {
  const sandbox = opts.sandboxOwner ? { namespace: 'demo' as const, sandbox_owner: opts.sandboxOwner, demo_advanced_ms: 0, synthetic: true } : {};
  return db.createRow(
    'programs',
    opts.programId,
    { ...detailsToRow(details), org_team_id: teamId, status: 'draft', synthetic: opts.synthetic ?? false, ...(opts.sourceNote ? { source_note: opts.sourceNote } : {}), ...sandbox },
    { permissions: teamRead(teamId) },
  );
}

export async function updateProgram(db: ServerDb, teamId: string, programId: string, details: ProgramDetails): Promise<Row<'programs'>> {
  requireDraft(await loadProgram(db, programId, teamId));
  return db.updateRow('programs', programId, detailsToRow(details));
}

/**
 * Replaces a draft program's sessions with the validated import. Upserts by a
 * deterministic (program, week, age group) ID, then deletes sessions that are
 * no longer listed, so rerunning the same import changes nothing.
 */
export async function replaceSessions(db: ServerDb, teamId: string, programId: string, sessions: readonly SessionRow[], opts: ScopeOption = {}): Promise<{ upserted: number; removed: number }> {
  requireDraft(await loadProgram(db, programId, teamId, opts.scope));
  if (sessions.length === 0) throw new AppError('validation', 'Import at least one session.');
  const rows = sessions.map((s) => ({
    $id: ledgerRowId(programId, s.week, s.ageGroup),
    $permissions: teamRead(teamId),
    program_id: programId,
    week: s.week,
    week_start: `${s.weekStart}T00:00:00.000Z`,
    age_group: s.ageGroup,
    min_age: s.minAge,
    max_age: s.maxAge,
    capacity: s.capacity,
    taken: 0,
    ...(s.label ? { label: s.label } : {}),
  }));
  for (let i = 0; i < rows.length; i += 100) await db.upsertRows('seat_ledger', rows.slice(i, i + 100));
  const keep = new Set(rows.map((r) => r.$id));
  const existing = await db.listRows('seat_ledger', [Query.equal('program_id', programId), Query.limit(1000)]);
  const stale = existing.rows.filter((r) => !keep.has(r.$id));
  for (const r of stale) await db.deleteRow('seat_ledger', r.$id);
  return { upserted: rows.length, removed: stale.length };
}

/** Capacity may change until the program freezes, but never below seats already taken. Throws AppError. */
export function checkCapacityChange(program: Row<'programs'>, ledger: Row<'seat_ledger'>, capacity: number): void {
  if (program.status !== 'draft' && program.status !== 'open') throw new AppError('locked', 'Capacity is fixed once applications close.');
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 10000) throw new AppError('validation', 'Capacity must be a whole number from 0 to 10000.', 'capacity');
  if (capacity < ledger.taken) throw new AppError('conflict', `Capacity cannot go below the ${ledger.taken} seats already taken.`, 'capacity');
}

export async function setCapacity(db: ServerDb, teamId: string, programId: string, ledgerId: string, capacity: number, opts: ScopeOption = {}): Promise<Row<'seat_ledger'>> {
  const program = await loadProgram(db, programId, teamId, opts.scope);
  const ledger = await db.getRow('seat_ledger', ledgerId).catch(() => null);
  if (!ledger || ledger.program_id !== programId) throw new AppError('not_found', 'Session not found.');
  checkCapacityChange(program, ledger, capacity);
  return db.updateRow('seat_ledger', ledgerId, { capacity });
}

export async function replaceZones(db: ServerDb, teamId: string, programId: string, zones: readonly ZoneInput[], opts: ScopeOption = {}): Promise<{ saved: number; removed: number }> {
  requireDraft(await loadProgram(db, programId, teamId, opts.scope));
  const ids = zones.map((_, i) => zoneRowId(programId, i));
  for (const [i, z] of zones.entries()) {
    const id = ids[i] ?? '';
    const data = { program_id: programId, name: z.name, tier: z.tier, area: z.area as unknown as number[][][] };
    await db.upsertRows('zones', [{ $id: id, $permissions: teamRead(teamId), ...data }]);
  }
  const existing = await db.listRows('zones', [Query.equal('program_id', programId), Query.limit(500)]);
  const stale = existing.rows.filter((r) => !ids.includes(r.$id));
  for (const r of stale) await db.deleteRow('zones', r.$id);
  return { saved: zones.length, removed: stale.length };
}

export interface PublishCheck {
  ok: boolean;
  problems: string[];
}

/** Everything that must hold before families can see a program. */
export async function checkPublishable(db: ServerDb, program: Row<'programs'>, now = new Date()): Promise<PublishCheck> {
  const problems: string[] = [];
  const details = programDetailsSchema.safeParse({
    name: program.name,
    description: program.description ?? '',
    timezone: program.timezone,
    windowOpen: program.window_open,
    windowClose: program.window_close,
    maxWeeks: program.max_weeks,
    defaultTier: program.default_tier ?? -1,
    tierLabels: JSON.parse(program.tier_labels ?? '{}') as unknown,
  });
  if (!details.success) problems.push(...details.error.issues.map((i) => i.message));
  if (new Date(program.window_close) <= now) problems.push('Applications must close in the future.');
  const sessions = await db.listRows('seat_ledger', [Query.equal('program_id', program.$id), Query.limit(1)]);
  if (sessions.total === 0) problems.push('Import at least one session.');
  const zones = await db.listRows('zones', [Query.equal('program_id', program.$id), Query.limit(500)]);
  const labels = JSON.parse(program.tier_labels ?? '{}') as Record<string, string>;
  for (const z of zones.rows) if (!(String(z.tier) in labels)) problems.push(`Zone "${z.name}" uses tier ${z.tier}, which has no label.`);
  return { ok: problems.length === 0, problems };
}

/**
 * Production: readable by anyone, and the drand round is announced now.
 * Demo sandbox (scope "demo"): readable by the sandbox Team only, and the
 * demo-timed round is announced when the visitor fast-forwards to the close
 * (functions/shared/sandbox.ts), still before the inputs are frozen.
 */
export async function publishProgram(db: ServerDb, teamId: string, programId: string, now = new Date(), opts: ScopeOption = {}): Promise<Row<'programs'>> {
  const program = await loadProgram(db, programId, teamId, opts.scope);
  const audience = isDemo(program) ? teamRead(teamId) : published(teamId);
  requireDraft(program);
  const check = await checkPublishable(db, program, now);
  if (!check.ok) throw new AppError('validation', `Not ready to publish: ${check.problems.join(' ')}`);

  const ledgers = await db.listRows('seat_ledger', [Query.equal('program_id', programId), Query.limit(1000)]);
  const zones = await db.listRows('zones', [Query.equal('program_id', programId), Query.limit(500)]);
  // Children rows first, program last: the catalogue never shows a program whose sessions are hidden.
  // Sessions and zones are created team-readable; a sandbox keeps exactly that, so only production re-grants.
  if (!isDemo(program)) {
    for (const l of ledgers.rows) await db.updateRow('seat_ledger', l.$id, {}, { permissions: audience });
    for (const z of zones.rows) await db.updateRow('zones', z.$id, {}, { permissions: audience });
  }
  // Announce the drand round now, before any application exists: a pure function of the window close (docs/FREEZE-PROTOCOL.md).
  const drandRound = isDemo(program) ? null : announcedRound(program.window_close);
  const announcement = drandRound === null ? {} : { drand_round: drandRound, drand_chain: DRAND_CHAIN.hash };
  const sessionsHash = sha256Hex(canonicalJson(ledgers.rows.map((l) => ({ week: l.week, age_group: l.age_group, min_age: l.min_age, max_age: l.max_age, capacity: l.capacity })).sort((a, b) => `${a.week}${a.age_group}`.localeCompare(`${b.week}${b.age_group}`))));
  const zonesHash = sha256Hex(canonicalJson(zones.rows.map((z) => ({ name: z.name, tier: z.tier, area: z.area })).sort((a, b) => a.name.localeCompare(b.name))));
  const payload = {
    window_open: program.window_open,
    window_close: program.window_close,
    max_weeks: program.max_weeks,
    sessions: ledgers.total,
    sessions_hash: sessionsHash,
    zones: zones.total,
    zones_hash: zonesHash,
    ...(drandRound === null
      ? { drand_round: null, demo: 'Demo sandbox: the demo-timed round is announced at the fast-forwarded close, before the freeze.' }
      : { drand_chain: DRAND_CHAIN.hash, drand_round: drandRound, drand_round_at: new Date(roundTimeMs(drandRound)).toISOString() }),
  };
  // The audit entry commits with the status change: two concurrent publishes take the same audit seq, so only one commits.
  for (let attempt = 1; ; attempt++) {
    try {
      return await transitionProgram(db, programId, 'open', { published_at: now.toISOString(), ...announcement, permissions: audience }, {
        stage: async (transactionId, current) => {
          requireDraft(current);
          const { rowId, entry } = await prepareAudit(db, { programId, event: 'program_published', payload });
          await db.createRow('audit_log', rowId, { program_id: programId, ...entry }, { transactionId });
        },
      });
    } catch (err) {
      const raced = (err instanceof AppError && (err.code === 'conflict' || err.code === 'locked')) || (err instanceof ServiceError && (err.mapped.kind === 'conflict' || err.mapped.kind === 'transaction_conflict'));
      if (!raced) throw err;
      requireDraft(await db.getRow('programs', programId)); // published by the other request
      if (attempt >= 5) throw err;
      await sleepBackoff(attempt, { baseDelayMs: 100 });
    }
  }
}

/**
 * Server-side home classification (verified geo semantics, docs/VERIFIED-BEHAVIOUR.md):
 * containment uses Query.intersects on [lng, lat] (edges count as inside);
 * homes just outside a zone are found with Query.distanceLessThan(.., 50, meters=true);
 * homes inside a zone but near its edge are detected in shared/geo.ts because
 * the database reports distance 0 for interior points.
 */
export async function classifyPoint(db: ServerDb, program: Row<'programs'>, point: LngLat): Promise<Classification> {
  const base = [Query.equal('program_id', program.$id), Query.limit(100)];
  const [containing, near] = await Promise.all([
    db.listRows('zones', [...base, Query.intersects('area', point)]),
    db.listRows('zones', [...base, Query.distanceLessThan('area', point, 50, true)]),
  ]);
  const inside = new Set(containing.rows.map((z) => z.$id));
  const asZone = (z: Row<'zones'>) => ({ tier: z.tier, area: z.area as unknown as Polygon });
  return classify(point, containing.rows.map(asZone), near.rows.filter((z) => !inside.has(z.$id)).map(asZone), program.default_tier ?? 9);
}
