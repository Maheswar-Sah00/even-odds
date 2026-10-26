/**
 * npm run seed:applicants [-- --count 120] [-- --reset]
 * Adds SYNTHETIC households with children, home points, tickets, applications
 * and preferences to the demo program, so odds and (later) the draw have
 * realistic demand. Every row is flagged synthetic; names are "[SYNTHETIC]".
 * Tiers are computed by the same server-side classifier families get.
 * --reset removes everything this script created (and nothing else).
 */
import { Permission, Query, Role } from 'node-appwrite';
import { createServerAppwrite } from '../functions/shared/appwrite-server.ts';
import { applicationRowId, preferenceRowId } from '../functions/shared/applications.ts';
import { childKey, deterministicId, newPublicId } from '../functions/shared/crypto.ts';
import { createServerDb } from '../functions/shared/db.ts';
import { locationRowId, ticketRowId } from '../functions/shared/household.ts';
import { classifyPoint } from '../functions/shared/organiser.ts';
import { formatEnvIssues, loadServerEnv } from '../functions/shared/server-env.ts';
import { weeksForChild } from '../shared/eligibility.ts';
import { mulberry32 } from '../shared/odds.ts';

const SEED_USER = 'synthetic-seed';
const PROGRAM_ID = 'demo-summer-2027';
const args = process.argv.slice(2);
const count = Number(args[args.indexOf('--count') + 1]) || 120;

const env = loadServerEnv();
if (!env.ok) {
  console.error(formatEnvIssues(env.issues));
  process.exit(2);
}
const secret = env.config.childKeySecret;
if (!secret) throw new Error('CHILD_KEY_SECRET is required');
const db = createServerDb(createServerAppwrite(env.config, { sink: null }));

const program = await db.getRow('programs', PROGRAM_ID);
const families = async () => (await db.listRows('families', [Query.equal('created_by', SEED_USER), Query.limit(5000)])).rows;

if (args.includes('--reset')) {
  const existing = await families();
  for (const f of existing) {
    for (const t of ['preferences', 'applications', 'tickets', 'children', 'family_locations'] as const) {
      await db.deleteRowsWhere(t, [Query.equal('family_id', f.$id)]);
    }
    await db.deleteRow('families', f.$id);
  }
  console.log(`Removed ${String(existing.length)} synthetic households.`);
  process.exit(0);
}

const rng = mulberry32(20271);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
/** Fisher-Yates shuffle, then a mild pull towards early-summer weeks (popular in real camps). */
const rankWeeks = <T extends { weekStart: string }>(weeks: readonly T[]): T[] => {
  const out = [...weeks];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  if (rng() < 0.45) out.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  return out;
};
const sessions = (await db.listRows('seat_ledger', [Query.equal('program_id', PROGRAM_ID), Query.limit(1000)])).rows;
const teamRead = [Permission.read(Role.team(program.org_team_id))];
const already = (await families()).length;

/** Same rule the server enforces at submission: "together only" needs a week every sibling ranked. */
const siblingModeFor = (rankings: string[][]): 'together_only' | 'together_preferred' | 'independent' => {
  if (rankings.length < 2) return 'independent';
  const mode = pick(['together_only', 'together_preferred', 'independent'] as const);
  const common = rankings.map((r) => new Set(r)).reduce((a, b) => new Set([...a].filter((w) => b.has(w))));
  return mode === 'together_only' && common.size === 0 ? 'together_preferred' : mode;
};

type Bulk = Record<'families' | 'family_locations' | 'children' | 'tickets' | 'applications' | 'preferences', Record<string, unknown>[]>;
const bulk: Bulk = { families: [], family_locations: [], children: [], tickets: [], applications: [], preferences: [] };
const pending: { familyId: string; home: [number, number]; kids: number }[] = [];

for (let i = already; i < already + count; i++) {
  const n = String(i).padStart(4, '0');
  const familyId = deterministicId('fa', 'synthetic', n);
  // Homes scattered around the demo zones (roughly 40% fall inside a zone).
  const home: [number, number] = [-77.31 + (rng() - 0.5) * 0.18, 38.85 + (rng() - 0.5) * 0.12];
  const kids = 1 + (rng() < 0.35 ? 1 : 0) + (rng() < 0.1 ? 1 : 0);
  const prefs = [];
  for (let k = 0; k < kids; k++) {
    const birth = new Date(Date.UTC(2014 + Math.floor(rng() * 8), Math.floor(rng() * 12), 1 + Math.floor(rng() * 28))).toISOString().slice(0, 10);
    const childId = deterministicId('ch', 'synthetic', n, String(k));
    const child = { family_id: familyId, first_name: `[SYNTHETIC] Child ${n}-${String(k + 1)}`, last_name: 'Demo', birthdate: `${birth}T00:00:00.000Z` };
    const eligible = weeksForChild(child.birthdate, sessions).filter((w) => w.ageGroup);
    if (eligible.length === 0) continue;
    bulk.children.push({ $id: childId, $permissions: [], ...child });
    bulk.tickets.push({ $id: ticketRowId(PROGRAM_ID, childId), $permissions: teamRead, program_id: PROGRAM_ID, child_id: childId, family_id: familyId, child_key: childKey(secret, { programId: PROGRAM_ID, firstName: child.first_name, lastName: child.last_name, birthdate: birth }) });
    const ranked = rankWeeks(eligible).slice(0, 1 + Math.floor(rng() * 3));
    prefs.push({ childId, ranked, requested: Math.min(ranked.length, 1 + (rng() < 0.4 ? 1 : 0)) });
  }
  if (prefs.length === 0) continue;
  bulk.families.push({ $id: familyId, $permissions: [], created_by: SEED_USER, synthetic: true });
  bulk.family_locations.push({ $id: locationRowId(familyId), $permissions: [], family_id: familyId, home });
  pending.push({ familyId, home, kids: prefs.length });
  bulk.applications.push({
    $id: applicationRowId(PROGRAM_ID, familyId),
    $permissions: teamRead,
    program_id: PROGRAM_ID,
    family_id: familyId,
    public_id: newPublicId(),
    sibling_mode: siblingModeFor(prefs.map((p) => p.ranked.map((w) => w.week))),
    status: 'submitted',
    submitted_at: new Date(Date.now() - rng() * 86400_000).toISOString(),
    synthetic: true,
  });
  for (const p of prefs) {
    bulk.preferences.push({ $id: preferenceRowId(PROGRAM_ID, p.childId), $permissions: teamRead, program_id: PROGRAM_ID, family_id: familyId, child_id: p.childId, ranked_weeks: p.ranked.map((w) => w.week), ranked_age_groups: p.ranked.map((w) => w.ageGroup ?? ''), requested_weeks: p.requested });
  }
}

// Tiers come from the same server-side classifier (TablesDB geo queries) that real families get.
for (let i = 0; i < pending.length; i += 10) {
  const batch = pending.slice(i, i + 10);
  const tiers = await Promise.all(batch.map((p) => classifyPoint(db, program, p.home)));
  batch.forEach((p, j) => {
    const app = bulk.applications.find((a) => a['family_id'] === p.familyId);
    if (app) Object.assign(app, { claimed_tier: tiers[j]?.tier, near_boundary: tiers[j]?.nearBoundary });
  });
}
for (const table of ['families', 'family_locations', 'children', 'tickets', 'applications', 'preferences'] as const) {
  const rows = bulk[table];
  for (let i = 0; i < rows.length; i += 100) await db.upsertRows(table, rows.slice(i, i + 100) as never);
  console.log(`  ${table}: ${String(rows.length)}`);
}
console.log(`Added ${String(pending.length)} synthetic households to ${PROGRAM_ID}.`);
