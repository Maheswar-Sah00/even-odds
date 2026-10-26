import { Query } from 'node-appwrite';
import type { SubmitApplicationInput } from '../../shared/application-input.ts';
import { weeksForChild } from '../../shared/eligibility.ts';
import { AppError } from './app-error.ts';
import { canonicalJson, deterministicId, newPublicId, sha256Hex } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { allRows, applicationWindow, ensureTicket, familyProgram, findRow, isKind, locationRowId, readFor, requireHousehold } from './household.ts';
import { classifyPoint } from './organiser.ts';

/**
 * Application submission. The client sends only choices (children, ranked
 * weeks, requested count, sibling mode). Everything that affects the draw is
 * decided here: window and late status, age eligibility per week (age on the
 * week's first day), the age group per ranked week, the claimed tier (from the
 * stored home and the zone polygons), tickets, and the pseudonymous public ID.
 *
 * Submission time is recorded for the receipt but is NEVER an input to
 * lottery order: within a tier, order comes only from the drand seed and the
 * public ID (see the draw module, Task 9).
 */

export const applicationRowId = (programId: string, familyId: string) => deterministicId('ap', 'application', programId, familyId);
export const preferenceRowId = (programId: string, childId: string) => deterministicId('pf', 'preference', programId, childId);
const SCOPE = 'submit-application';

export interface SubmitResult {
  status: 'submitted' | 'updated' | 'replayed';
  applicationId: string;
  publicId: string;
  claimedTier: number;
  nearBoundary: boolean;
  late: boolean;
}

interface Problem {
  field: string;
  message: string;
}

const fail = (problems: Problem[]): never => {
  const first = problems[0];
  throw new AppError('validation', problems.map((p) => p.message).join(' '), first?.field);
};

export async function submitApplication(db: ServerDb, secret: string, userId: string, input: SubmitApplicationInput, now = new Date()): Promise<SubmitResult> {
  // The key is scoped to the caller's household and program, and bound to this exact request:
  // another household's key replays nothing, and reusing a key for an edited request is refused.
  const household = await requireHousehold(db, userId);
  const { idempotencyKey, ...request } = input;
  const fingerprint = sha256Hex(canonicalJson(request));
  const idemId = deterministicId('ik', SCOPE, household.familyId, input.programId, idempotencyKey);
  const replay = async (): Promise<SubmitResult | null> => {
    const row = await findRow(db, 'idempotency', idemId);
    if (!row) return null;
    const stored = JSON.parse(row.result ?? '{}') as SubmitResult & { fingerprint?: string };
    if (stored.fingerprint !== fingerprint) throw new AppError('conflict', 'This request key was already used for a different application. Reload and submit again.');
    const { fingerprint: _, ...result } = stored;
    return { ...result, status: 'replayed' };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const program = await familyProgram(db, input.programId);
  const window = applicationWindow(program, now);
  if (!window.open) throw new AppError('locked', 'This program is not accepting applications right now.');

  const sessions = await allRows(db, 'seat_ledger', [Query.equal('program_id', program.$id)]);
  const problems: Problem[] = [];
  const children: Row<'children'>[] = [];
  const derived: { childId: string; weeks: string[]; ageGroups: string[]; requested: number }[] = [];

  for (const [i, c] of input.children.entries()) {
    const child = await findRow(db, 'children', c.childId);
    if (!child || child.family_id !== household.familyId) throw new AppError('not_found', 'Child not found.');
    children.push(child);
    const eligibility = new Map(weeksForChild(child.birthdate, sessions).map((w) => [w.week, w]));
    const ageGroups: string[] = [];
    for (const week of c.rankedWeeks) {
      const w = eligibility.get(week);
      if (!w) problems.push({ field: `children.${String(i)}.rankedWeeks`, message: `${child.first_name}: week ${week} is not part of this program.` });
      else if (!w.ageGroup) problems.push({ field: `children.${String(i)}.rankedWeeks`, message: `${child.first_name}: not eligible for ${w.label ?? week}. ${w.reason ?? ''}` });
      else ageGroups.push(w.ageGroup);
    }
    const cap = Math.min(program.max_weeks, c.rankedWeeks.length);
    if (c.requestedWeeks > cap) problems.push({ field: `children.${String(i)}.requestedWeeks`, message: `${child.first_name}: you can ask for at most ${String(cap)} week(s).` });
    derived.push({ childId: child.$id, weeks: c.rankedWeeks, ageGroups, requested: c.requestedWeeks });
  }
  if (input.siblingMode === 'together_only' && input.children.length > 1) {
    const common = input.children.map((c) => new Set(c.rankedWeeks)).reduce((a, b) => new Set([...a].filter((w) => b.has(w))));
    if (common.size === 0) problems.push({ field: 'siblingMode', message: '"Together only" needs at least one week that every child has chosen; otherwise no placement is possible.' });
  }
  if (problems.length > 0) fail(problems);

  // Tickets: one per child per program, protected by UNIQUE(program_id, child_key).
  for (const child of children) {
    const t = await ensureTicket(db, secret, household, program, child);
    if (t.status === 'possible_duplicate') {
      throw new AppError('conflict', `${child.first_name} appears to already have a ticket for this program through another household. We can't share details; if their other parent or carer applied, ask them for a household invite code.`, 'children');
    }
  }

  // Claimed tier from the stored home (server-side geo). No home = default tier.
  const location = await findRow(db, 'family_locations', locationRowId(household.familyId));
  const tier = location ? await classifyPoint(db, program, location.home) : { tier: program.default_tier ?? 9, nearBoundary: false };

  const applicationId = applicationRowId(program.$id, household.familyId);
  const existing = await findRow(db, 'applications', applicationId);
  const publicId = existing?.public_id ?? newPublicId();
  // Lateness is fixed at first submission: an on-time household editing later stays on time.
  const late = existing ? (existing.late ?? false) : window.late;
  const perms = readFor(household.guardianIds, [program.org_team_id]);
  const previous = await allRows(db, 'preferences', [Query.equal('program_id', program.$id), Query.equal('family_id', household.familyId)]);
  const keep = new Set(derived.map((d) => preferenceRowId(program.$id, d.childId)));
  const result: SubmitResult = { status: existing ? 'updated' : 'submitted', applicationId, publicId, claimedTier: tier.tier, nearBoundary: tier.nearBoundary, late };

  const tx = await db.transactions.begin(60);
  try {
    await db.upsertRow(
      'applications',
      applicationId,
      {
        program_id: program.$id,
        family_id: household.familyId,
        public_id: publicId,
        sibling_mode: input.siblingMode,
        status: 'submitted',
        submitted_at: existing?.submitted_at ?? now.toISOString(),
        late,
        claimed_tier: tier.tier,
        near_boundary: tier.nearBoundary,
        synthetic: existing?.synthetic ?? false,
        ...(existing?.verified_tier === undefined || existing.verified_tier === null ? {} : { verified_tier: existing.verified_tier }),
      },
      { permissions: perms, transactionId: tx.$id },
    );
    for (const d of derived) {
      await db.upsertRow(
        'preferences',
        preferenceRowId(program.$id, d.childId),
        { program_id: program.$id, family_id: household.familyId, child_id: d.childId, ranked_weeks: d.weeks, ranked_age_groups: d.ageGroups, requested_weeks: d.requested },
        { permissions: perms, transactionId: tx.$id },
      );
    }
    for (const p of previous) if (!keep.has(p.$id)) await db.deleteRow('preferences', p.$id, tx.$id);
    await db.createRow('idempotency', idemId, { scope: SCOPE, program_id: program.$id, key_hash: sha256Hex(idempotencyKey), result: JSON.stringify({ ...result, fingerprint }) }, { transactionId: tx.$id });
  } catch (err) {
    await db.transactions.rollback(tx.$id).catch(() => undefined);
    throw err;
  }
  try {
    await db.transactions.commit(tx.$id);
  } catch (err) {
    if (!isKind(err, 'transaction_conflict')) throw err;
    const replayed = await replay();
    if (replayed) return replayed;
    throw new AppError('conflict', 'Your application changed at the same time somewhere else. Reload and try again.');
  }

  // Children dropped from the application lose their ticket for this program.
  for (const p of previous) if (!keep.has(p.$id)) await db.deleteRow('tickets', deterministicId('tk', 'ticket', program.$id, p.child_id)).catch(() => undefined);
  return result;
}

/** Withdraws before applications freeze. The application row stays as a record. */
export async function withdrawApplication(db: ServerDb, userId: string, programId: string): Promise<{ status: 'withdrawn' }> {
  const household = await requireHousehold(db, userId);
  const program = await familyProgram(db, programId);
  if (program.status !== 'open') throw new AppError('locked', 'Applications are frozen; contact the organiser to decline a place instead.');
  const app = await findRow(db, 'applications', applicationRowId(programId, household.familyId));
  if (!app) throw new AppError('not_found', 'You have no application for this program.');
  await db.updateRow('applications', app.$id, { status: 'withdrawn' });
  return { status: 'withdrawn' };
}
