import { Query } from 'node-appwrite';
import { estimateOdds, type OddsInput, type OddsResult } from '../../shared/odds.ts';
import { deterministicId } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { allRows, findRow } from './household.ts';

/**
 * Hourly odds job. Reads submitted applications and preferences, builds
 * PSEUDONYMOUS estimator inputs (public IDs, tiers, sibling modes, ranked
 * weeks and age groups; no names, birthdates, homes, family or user IDs, and
 * no submission times), and publishes aggregates only.
 *
 * Freeze: from window_close - 24 h the published snapshot is marked frozen and
 * never recomputed, so late changes in demand cannot be gamed off live odds.
 */

export const oddsRowId = (programId: string) => deterministicId('od', 'odds', programId);
export const FREEZE_BEFORE_CLOSE_MS = 24 * 3600_000;

export async function buildOddsInput(db: ServerDb, program: Row<'programs'>): Promise<OddsInput> {
  const [apps, prefs, seats] = await Promise.all([
    allRows(db, 'applications', [Query.equal('program_id', program.$id), Query.equal('status', 'submitted')]),
    allRows(db, 'preferences', [Query.equal('program_id', program.$id)]),
    allRows(db, 'seat_ledger', [Query.equal('program_id', program.$id)]),
  ]);
  return {
    maxWeeks: program.max_weeks,
    seats: seats.map((s) => ({ week: s.week, ageGroup: s.age_group, capacity: s.capacity })),
    applicants: apps
      .map((a) => ({
        publicId: a.public_id,
        tier: a.verified_tier ?? a.claimed_tier ?? program.default_tier ?? 9,
        late: a.late ?? false,
        siblingMode: a.sibling_mode,
        children: prefs
          .filter((p) => p.family_id === a.family_id)
          .map((p) => ({ rankedWeeks: p.ranked_weeks, ageGroups: p.ranked_age_groups ?? [], requested: p.requested_weeks })),
      }))
      .filter((a) => a.children.length > 0),
  };
}

export const iterationsFor = (children: number) => (children <= 300 ? 2000 : children <= 2000 ? 600 : 300);

export type OddsRunOutcome = { status: 'computed'; result: OddsResult } | { status: 'frozen' } | { status: 'skipped'; reason: string };

export async function runOddsForProgram(db: ServerDb, program: Row<'programs'>, now = new Date()): Promise<OddsRunOutcome> {
  if (program.status !== 'open') return { status: 'skipped', reason: `program is ${program.status}` };
  const freezeAt = new Date(new Date(program.window_close).getTime() - FREEZE_BEFORE_CLOSE_MS);
  const rowId = oddsRowId(program.$id);
  const existing = await findRow(db, 'odds_snapshots', rowId);
  if (now >= freezeAt) {
    if (existing && !existing.frozen) await db.updateRow('odds_snapshots', rowId, { frozen: true });
    return existing ? { status: 'frozen' } : { status: 'skipped', reason: 'freeze period began before any estimate was published' };
  }

  const input = await buildOddsInput(db, program);
  const children = input.applicants.reduce((n, a) => n + a.children.length, 0);
  // Seed = program + hour, so a given hour's estimate can be reproduced exactly.
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  const seed = `${program.$id}:${hour.toISOString()}`;
  const result = estimateOdds(input, { iterations: iterationsFor(children), seed });
  await db.upsertRow('odds_snapshots', rowId, {
    program_id: program.$id,
    computed_at: now.toISOString(),
    model_version: result.modelVersion,
    iterations: result.iterations,
    seed,
    applicants: result.applicants,
    children: result.children,
    seats: result.seats,
    tiers: JSON.stringify(result.tiers),
    sessions: JSON.stringify(result.sessions),
    frozen: false,
    freeze_at: freezeAt.toISOString(),
  });
  return { status: 'computed', result };
}

export async function runOddsJob(db: ServerDb, now = new Date(), programIds?: string[]): Promise<Record<string, OddsRunOutcome['status']>> {
  const programs = programIds
    ? (await Promise.all(programIds.map((id) => findRow(db, 'programs', id)))).filter((p): p is Row<'programs'> => p !== null)
    : await allRows(db, 'programs', [Query.equal('status', 'open')]);
  const out: Record<string, OddsRunOutcome['status']> = {};
  for (const p of programs) out[p.$id] = (await runOddsForProgram(db, p, now)).status;
  return out;
}
