import { Permission, Query, Role } from 'node-appwrite';
import { computePlan, DRAW_ALGORITHM, INPUTS_SCHEMA, inputsHash, planHash, type DrawInputs, type DrawPlan, type PlanStep } from '../../shared/draw/index.ts';
import { AppError } from './app-error.ts';
import { deterministicId } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { allRows, ticketRowId } from './household.ts';
import { placeGroup } from './placement.ts';
import { transitionProgram } from './program-status.ts';

/**
 * Draw commit layer: applies the plan from the pure draw module
 * (shared/draw) to TablesDB. The plan decides; the database enforces.
 *
 * - Every plan step is one placeGroup() transaction (capped seat increments +
 *   UNIQUE(program, child, week) + idempotency row), so a sibling group is
 *   placed whole or not at all.
 * - Step idempotency key = `${drawRunId}:${step.index}`: re-running a step after
 *   a crash or a retry returns "replayed" and never duplicates a placement.
 * - Progress is stored in draw_runs.cursor; executeDrawRun resumes from it and
 *   stops at a time budget, so large draws span several Function runs.
 * - Capacity conflicts are resolved inside the planner (next preference). If
 *   the database ever disagrees with the plan (e.g. seats changed after
 *   freeze), the run is marked failed at that step and stops: differences are
 *   surfaced, never patched over.
 */

export interface DrawContext {
  inputs: DrawInputs;
  /** ticket ref -> real child and family (server-only; never published). */
  children: Map<string, { childId: string; familyId: string }>;
  /** public ID -> family ID (server-only). */
  families: Map<string, string>;
  /** public ID -> submitted_at (server-only; only the resulting order is published, at freeze). Absent for snapshot contexts. */
  submittedAt?: Map<string, string | null>;
}

/** Builds pseudonymous draw inputs from frozen database rows. */
export async function buildDrawInputs(db: ServerDb, program: Row<'programs'>): Promise<DrawContext> {
  const [apps, prefs, sessions, overrides] = await Promise.all([
    allRows(db, 'applications', [Query.equal('program_id', program.$id), Query.equal('status', 'submitted')]),
    allRows(db, 'preferences', [Query.equal('program_id', program.$id)]),
    allRows(db, 'seat_ledger', [Query.equal('program_id', program.$id)]),
    allRows(db, 'overrides', [Query.equal('program_id', program.$id), Query.equal('created_before_freeze', true)]),
  ]);
  const children = new Map<string, { childId: string; familyId: string }>();
  const families = new Map<string, string>();
  const familyToPublic = new Map(apps.map((a) => [a.family_id, a.public_id]));
  const inputs: DrawInputs = {
    schema: INPUTS_SCHEMA,
    algorithm: DRAW_ALGORITHM,
    programId: program.$id,
    maxWeeks: program.max_weeks,
    sessions: sessions.map((s) => ({ week: s.week, ageGroup: s.age_group, capacity: s.capacity })),
    applications: apps.map((a) => {
      families.set(a.public_id, a.family_id);
      return {
        publicId: a.public_id,
        tier: a.verified_tier ?? a.claimed_tier ?? program.default_tier ?? 9,
        late: a.late ?? false,
        siblingMode: a.sibling_mode,
        children: prefs
          .filter((p) => p.family_id === a.family_id)
          .map((p) => {
            const ref = ticketRowId(program.$id, p.child_id);
            children.set(ref, { childId: p.child_id, familyId: a.family_id });
            return { ref, rankedWeeks: p.ranked_weeks, ageGroups: p.ranked_age_groups ?? [], requested: p.requested_weeks };
          }),
      };
    }),
    overrides: overrides
      .filter((o) => familyToPublic.has(o.family_id))
      // Only THAT a family has an override is a draw input (and published); reason and pool stay with staff.
      .map((o) => ({ publicId: familyToPublic.get(o.family_id) ?? '' })),
  };
  return { inputs, children, families, submittedAt: new Map(apps.map((a) => [a.public_id, a.submitted_at ?? null])) };
}

export async function startDrawRun(db: ServerDb, opts: { programId: string; drawRunId: string; seedHex: string; drandRound: number; inputs: DrawInputs }): Promise<Row<'draw_runs'>> {
  return db.createRow('draw_runs', opts.drawRunId, {
    program_id: opts.programId,
    status: 'pending',
    drand_round: opts.drandRound,
    seed: opts.seedHex,
    inputs_hash: inputsHash(opts.inputs),
    cursor: 0,
  });
}

export type DrawRunOutcome =
  | { status: 'completed'; plan: DrawPlan }
  | { status: 'running'; cursor: number; total: number }
  | { status: 'failed'; error: string };

export interface ExecuteOptions {
  /** Stop starting new batches after this long (a Function run has a hard timeout). */
  timeBudgetMs?: number;
  /** Plan steps committed in parallel per batch; safe because caps and unique indexes enforce correctness. */
  concurrency?: number;
  now?: () => number;
}

export async function executeDrawRun(db: ServerDb, drawRunId: string, ctx: DrawContext, opts: ExecuteOptions = {}): Promise<DrawRunOutcome> {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const run = await db.getRow('draw_runs', drawRunId);
  let computed: DrawPlan | null = null;
  const fail = async (error: string): Promise<DrawRunOutcome> => {
    // Workers can overlap (scheduled tick + manual run). One that read the run before another moved
    // it on (started it, or completed it and moved the program to "drawn") must not overwrite that
    // progress with a failure it only saw because its read was stale (Task 14 stress suite).
    const latest = await db.getRow('draw_runs', drawRunId);
    if (computed && latest.status === 'completed') return { status: 'completed', plan: computed };
    if (computed && run.status === 'pending' && latest.status === 'running') return { status: 'running', cursor: latest.cursor, total: computed.steps.length };
    await db.updateRow('draw_runs', drawRunId, { status: 'failed', error: error.slice(0, 256), finished_at: new Date(now()).toISOString() });
    return { status: 'failed', error };
  };
  if (run.status === 'failed') return { status: 'failed', error: run.error ?? 'failed' };
  if (!run.seed) return fail('No seed: the draw cannot run before the public random value is known.');
  if (inputsHash(ctx.inputs) !== run.inputs_hash) return fail('Inputs do not match the frozen inputs hash.');

  const plan = computePlan(ctx.inputs, run.seed);
  computed = plan;
  const hash = planHash(plan);
  if (run.status === 'completed') return { status: 'completed', plan };
  if (run.plan_hash && run.plan_hash !== hash) return fail('Recomputed plan differs from the plan this run started with.');

  const program = await db.getRow('programs', run.program_id);
  if (program.status !== 'frozen') return fail(`Program must be frozen to draw (it is "${program.status}").`);

  if (run.status === 'pending') {
    // Precondition (checked once, when the run starts): the database matches the frozen inputs and no seat is taken.
    const ledgers = await allRows(db, 'seat_ledger', [Query.equal('program_id', run.program_id)]);
    const frozen = new Map(ctx.inputs.sessions.map((s) => [`${s.week}\u0000${s.ageGroup}`, s.capacity]));
    for (const l of ledgers) {
      if (frozen.get(`${l.week}\u0000${l.age_group}`) !== l.capacity) return fail(`Capacity of ${l.week}/${l.age_group} changed after freeze.`);
      if (l.taken !== 0) return fail(`Seats in ${l.week}/${l.age_group} were taken before the draw.`);
    }
    await db.updateRow('draw_runs', drawRunId, { status: 'running', plan_hash: hash, started_at: new Date(now()).toISOString() });
  }

  const guardianCache = new Map<string, string[]>();
  const permissionsFor = async (familyId: string) => {
    if (!guardianCache.has(familyId)) {
      const g = await allRows(db, 'guardians', [Query.equal('family_id', familyId)]);
      guardianCache.set(familyId, g.map((x) => x.user_id));
    }
    return [...(guardianCache.get(familyId) ?? []).map((u) => Permission.read(Role.user(u))), Permission.read(Role.team(program.org_team_id))];
  };

  const commitStep = async (step: PlanStep): Promise<string | null> => {
    const familyId = ctx.families.get(step.publicId);
    if (!familyId) return `Step ${String(step.index)}: unknown application`;
    const week = step.placements[0]?.week ?? '';
    const members = step.placements.map((p) => {
      const child = ctx.children.get(p.childRef);
      if (!child) throw new AppError('validation', `Step ${String(step.index)}: unknown child reference`);
      return { childId: child.childId, ageGroup: p.ageGroup };
    });
    const result = await placeGroup(db, {
      programId: run.program_id,
      familyId,
      week,
      members,
      idempotencyKey: `${drawRunId}:${String(step.index)}`,
      permissions: await permissionsFor(familyId),
      drawRunId,
      round: step.round,
    });
    if (result.status === 'placed' || result.status === 'replayed') return null;
    return `Step ${String(step.index)} (round ${String(step.round)}, ${week}) diverged from the plan: database says ${result.status}.`;
  };

  const batch = Math.max(1, opts.concurrency ?? 4);
  let cursor = run.cursor;
  let batches = 0;
  while (cursor < plan.steps.length) {
    // Always make progress: at least one batch per call, then honour the budget.
    if (batches > 0 && opts.timeBudgetMs !== undefined && now() - started > opts.timeBudgetMs) {
      return { status: 'running', cursor, total: plan.steps.length };
    }
    const slice = plan.steps.slice(cursor, cursor + batch);
    const errors = (await Promise.all(slice.map(commitStep))).filter((e): e is string => e !== null);
    if (errors.length > 0) {
      await db.updateRow('draw_runs', drawRunId, { cursor });
      return fail(errors[0] ?? 'divergence');
    }
    cursor += slice.length;
    batches++;
    await db.updateRow('draw_runs', drawRunId, { cursor });
  }

  // Waitlist in lottery order; deterministic IDs make this idempotent.
  // rank = the family's lottery position, so promotion can merge a week's age-group lists (offers.ts).
  const rankOf = new Map(plan.order.map((o) => [o.publicId, o.position]));
  const waitRows = await Promise.all(
    plan.waitlist.map(async (w) => {
      const child = ctx.children.get(w.childRef);
      const familyId = ctx.families.get(w.publicId) ?? '';
      return {
        $id: deterministicId('wl', drawRunId, w.week, w.ageGroup, String(w.position)),
        $permissions: await permissionsFor(familyId),
        program_id: run.program_id,
        week: w.week,
        age_group: w.ageGroup,
        family_id: familyId,
        child_id: child?.childId ?? '',
        position: w.position,
        rank: rankOf.get(w.publicId) ?? null,
        status: 'waiting' as const,
      };
    }),
  );
  for (let i = 0; i < waitRows.length; i += 100) await db.upsertRows('waitlist', waitRows.slice(i, i + 100));

  await db.updateRow('draw_runs', drawRunId, { status: 'completed', cursor, finished_at: new Date(now()).toISOString() });
  await transitionProgram(db, run.program_id, 'drawn').catch(async (err: unknown) => {
    // An overlapping worker finished the same run first.
    if ((await db.getRow('programs', run.program_id)).status !== 'drawn') throw err;
  });
  return { status: 'completed', plan };
}
