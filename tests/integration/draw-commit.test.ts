/**
 * Task 9 commit layer against REAL TablesDB. Each scenario gets its own
 * synthetic program, so placements never collide across scenarios.
 */
import { ID, Query } from 'node-appwrite';
import { afterAll, describe, expect, it } from 'vitest';
import { applicationRowId, preferenceRowId } from '../../functions/shared/applications.ts';
import { newPublicId } from '../../functions/shared/crypto.ts';
import { buildDrawInputs, executeDrawRun, startDrawRun, type DrawContext } from '../../functions/shared/draw-commit.ts';
import { ticketRowId } from '../../functions/shared/household.ts';
import { createProgram, ledgerRowId, publishProgram, replaceSessions } from '../../functions/shared/organiser.ts';
import { transitionProgram } from '../../functions/shared/program-status.ts';
import { computePlan, planHash, type DrawPlan } from '../../shared/draw/index.ts';
import type { TableKey } from '../../shared/config.ts';
import { parseSessionsCsv, programDetailsSchema } from '../../shared/program-input.ts';
import { db, RUN_ID, serverEnv } from './helpers/server.ts';

const teamId = serverEnv.organiserTeamId ?? 'organisers';
const SEED = 'c0ffee'.repeat(10) + 'beef';
const programs: string[] = [];

// Two weeks x two age groups. Small capacities so the draw is contested.
const CSV = 'week,week_start,age_group,min_age,max_age,capacity\nW1,2027-06-21,young,5,7,3\nW1,2027-06-21,old,8,10,2\nW2,2027-06-28,young,5,7,2\nW2,2027-06-28,old,8,10,2\n';

async function scenario(name: string, families = 8) {
  const programId = `itd-${name}-${RUN_ID}`.slice(0, 36);
  programs.push(programId);
  const now = Date.now();
  await createProgram(
    db,
    teamId,
    programDetailsSchema.parse({ name: `[SYNTHETIC] draw ${name} ${RUN_ID}`, timezone: 'UTC', windowOpen: new Date(now - 7200_000).toISOString(), windowClose: new Date(now + 2 * 86400_000).toISOString(), maxWeeks: 2, defaultTier: 1, tierLabels: { '0': 'A', '1': 'B' } }),
    { programId, synthetic: true },
  );
  await replaceSessions(db, teamId, programId, parseSessionsCsv(CSV).sessions);
  await publishProgram(db, teamId, programId);
  for (let i = 0; i < families; i++) {
    const familyId = `fd-${name}-${String(i)}-${RUN_ID}`.slice(0, 36);
    const kids = i % 3 === 0 ? 2 : 1;
    await db.createRow('applications', applicationRowId(programId, familyId), {
      program_id: programId, family_id: familyId, public_id: newPublicId(), status: 'submitted', claimed_tier: i % 4 === 0 ? 0 : 1, synthetic: true,
      sibling_mode: kids > 1 ? (['together_only', 'together_preferred'] as const)[i % 2] ?? 'independent' : 'independent',
    });
    for (let k = 0; k < kids; k++) {
      const childId = `cd-${name}-${String(i)}-${String(k)}-${RUN_ID}`.slice(0, 36);
      const group = (i + k) % 2 === 0 ? 'young' : 'old';
      await db.createRow('tickets', ticketRowId(programId, childId), { program_id: programId, child_id: childId, family_id: familyId, child_key: newPublicId() + newPublicId() });
      await db.createRow('preferences', preferenceRowId(programId, childId), {
        program_id: programId, family_id: familyId, child_id: childId, ranked_weeks: i % 2 ? ['W1', 'W2'] : ['W2', 'W1'], ranked_age_groups: [group, group], requested_weeks: 1 + (i % 2),
      });
    }
  }
  await transitionProgram(db, programId, 'frozen');
  const ctx = await buildDrawInputs(db, await db.getRow('programs', programId));
  const runId = ID.unique();
  await startDrawRun(db, { programId, drawRunId: runId, seedHex: SEED, drandRound: 1, inputs: ctx.inputs });
  return { programId, ctx, runId, plan: computePlan(ctx.inputs, SEED) };
}

afterAll(async () => {
  const tables: TableKey[] = ['placements', 'waitlist', 'idempotency', 'preferences', 'tickets', 'applications', 'seat_ledger', 'audit_log', 'draw_runs'];
  for (const programId of programs) {
    for (const t of tables) {
      for (;;) {
        const { rows } = await db.listRows(t, [Query.equal('program_id', programId), Query.limit(100)]);
        if (rows.length === 0) break;
        await Promise.all(rows.map((r) => db.deleteRow(t, r.$id)));
      }
    }
    await db.deleteRow('programs', programId).catch(() => undefined);
  }
});

const dbPlacements = async (programId: string) => (await db.listRows('placements', [Query.equal('program_id', programId), Query.limit(500)])).rows;
const asSet = (xs: string[]) => [...xs].sort();
const planned = (plan: DrawPlan, ctx: DrawContext) => plan.steps.flatMap((s) => s.placements.map((p) => `${ctx.children.get(p.childRef)?.childId ?? '?'}@${p.week}`));

describe('committing a plan (real TablesDB)', () => {
  it('commits exactly the planned placements, waitlist and seat counts', async () => {
    const { programId, ctx, runId, plan } = await scenario('full');
    expect(plan.steps.length).toBeGreaterThan(3);
    const out = await executeDrawRun(db, runId, ctx, { concurrency: 3 });
    expect(out.status).toBe('completed');

    const rows = await dbPlacements(programId);
    expect(asSet(rows.map((r) => `${r.child_id}@${r.week}`))).toEqual(asSet(planned(plan, ctx)));
    for (const s of ctx.inputs.sessions) {
      const ledger = await db.getRow('seat_ledger', ledgerRowId(programId, s.week, s.ageGroup));
      const expected = plan.steps.flatMap((x) => x.placements).filter((p) => p.week === s.week && p.ageGroup === s.ageGroup).length;
      expect(ledger.taken).toBe(expected);
      expect(ledger.taken).toBeLessThanOrEqual(ledger.capacity);
    }
    const wait = await db.listRows('waitlist', [Query.equal('program_id', programId), Query.limit(500)]);
    expect(wait.total).toBe(plan.waitlist.length);
    const run = await db.getRow('draw_runs', runId);
    expect(run).toMatchObject({ status: 'completed', cursor: plan.steps.length, plan_hash: planHash(plan) });
    expect((await db.getRow('programs', programId)).status).toBe('drawn');

    // Executing a completed run again changes nothing.
    await expect(executeDrawRun(db, runId, ctx)).resolves.toMatchObject({ status: 'completed' });
    expect((await dbPlacements(programId)).length).toBe(rows.length);
  });

  it('resumes from its cursor after a time budget, and re-running steps after a crash never duplicates', async () => {
    const { programId, ctx, runId, plan } = await scenario('resume');
    let t = 0;
    const first = await executeDrawRun(db, runId, ctx, { concurrency: 2, timeBudgetMs: 1, now: () => (t += 1) });
    expect(first.status).toBe('running');
    const cursor = (await db.getRow('draw_runs', runId)).cursor;
    expect(cursor).toBeGreaterThan(0);
    expect(cursor).toBeLessThan(plan.steps.length);

    // Simulate a crash that lost the cursor update: steps already committed run again.
    await db.updateRow('draw_runs', runId, { cursor: 0 });
    await expect(executeDrawRun(db, runId, ctx, { concurrency: 2 })).resolves.toMatchObject({ status: 'completed' });
    const rows = await dbPlacements(programId);
    expect(rows.length).toBe(plan.summary.placements);
    expect(new Set(rows.map((r) => `${r.child_id}@${r.week}`)).size).toBe(rows.length);
  });

  it('refuses to start when seats were taken before the draw', async () => {
    const { programId, ctx, runId } = await scenario('pretaken', 3);
    await db.incrementRowColumn('seat_ledger', ledgerRowId(programId, 'W1', 'young'), 'taken', { value: 1, max: 3 });
    const out = await executeDrawRun(db, runId, ctx);
    expect(out).toMatchObject({ status: 'failed', error: expect.stringMatching(/taken before the draw/) as unknown });
    expect(await dbPlacements(programId)).toEqual([]);
  });

  it('halts at the first step the database refuses, without partial sibling placements', async () => {
    const { programId, ctx, runId, plan } = await scenario('diverge');
    // Start normally, then shrink a session mid-draw (as if capacity changed after freeze).
    let t = 0;
    await executeDrawRun(db, runId, ctx, { concurrency: 1, timeBudgetMs: 1, now: () => (t += 1) });
    const target = plan.steps.slice(1).find((s) => s.placements.length > 0);
    const p = target?.placements[0];
    if (!target || !p) throw new Error('fixture: expected a later step');
    const ledger = await db.getRow('seat_ledger', ledgerRowId(programId, p.week, p.ageGroup));
    await db.updateRow('seat_ledger', ledger.$id, { capacity: ledger.taken });
    const out = await executeDrawRun(db, runId, ctx, { concurrency: 1 });
    expect(out).toMatchObject({ status: 'failed', error: expect.stringMatching(/diverged from the plan/) as unknown });
    // Every family's placements came from whole steps: no family has a partial group step.
    const rows = await dbPlacements(programId);
    for (const step of plan.steps.filter((s) => s.kind === 'group')) {
      const ids = step.placements.map((x) => `${ctx.children.get(x.childRef)?.childId ?? ''}@${x.week}`);
      const present = ids.filter((id) => rows.some((r) => `${r.child_id}@${r.week}` === id)).length;
      expect([0, ids.length]).toContain(present);
    }
    expect((await db.getRow('draw_runs', runId)).status).toBe('failed');
  });

  it('refuses inputs that differ from the frozen inputs hash', async () => {
    const { ctx, runId } = await scenario('tamper', 2);
    const tampered: DrawContext = { ...ctx, inputs: { ...ctx.inputs, applications: ctx.inputs.applications.map((a) => ({ ...a, tier: 0 })) } };
    await expect(executeDrawRun(db, runId, tampered)).resolves.toMatchObject({ status: 'failed', error: expect.stringMatching(/frozen inputs hash/) as unknown });
  });
});
