import { Query } from 'node-appwrite';
import { ServiceError } from '../../shared/errors.ts';
import { AppError } from './app-error.ts';
import type { ServerDb } from './db.ts';
import { buildDrawInputs, executeDrawRun } from './draw-commit.ts';
import { publishDrawResult } from './draw-result.ts';
import { frozenInputsRowId, loadFrozenContext, protocolDrawRunId, recordDrawOutcome, resolveBeacon, seedProvenanceProblem, type BeaconOptions } from './freeze.ts';
import { allRows, findRow } from './household.ts';
import { issueOffers } from './offers.ts';

/**
 * Advances one draw run as far as the time budget allows. Shared by the
 * hourly jobs Function and the judge sandbox (functions/shared/sandbox.ts),
 * so a demo draw runs exactly the production code path: verified beacon,
 * snapshot-only inputs, placeGroup transactions, then the 48 h offer clock.
 */
export async function advanceDraw(db: ServerDb, drawRunId: string, opts: { budgetMs: number; concurrency?: number; beacon?: BeaconOptions }) {
  let run = await db.getRow('draw_runs', drawRunId);
  const program = await db.getRow('programs', run.program_id);
  // Programs frozen through the protocol draw ONLY from their snapshot, with a seed from a verified beacon.
  const protocol = Boolean(await findRow(db, 'frozen_inputs', frozenInputsRowId(program.$id)));
  if (protocol) {
    if (drawRunId !== protocolDrawRunId(program.$id)) return { status: 'refused' as const, reason: 'Only the draw run created at freeze may draw this program.' };
    if (!run.seed) {
      const beacon = await resolveBeacon(db, drawRunId, opts.beacon);
      if (beacon.status !== 'verified' && beacon.status !== 'already_verified') return { status: 'pending' as const, beacon };
      run = await db.getRow('draw_runs', drawRunId);
    }
    const problem = await seedProvenanceProblem(run, program);
    if (problem) return { status: 'refused' as const, reason: problem };
  }
  const ctx = (protocol ? await loadFrozenContext(db, program) : null) ?? (await buildDrawInputs(db, program));
  const outcome = await executeDrawRun(db, drawRunId, ctx, { timeBudgetMs: opts.budgetMs, concurrency: opts.concurrency ?? 4 });
  if (protocol && outcome.status !== 'running') {
    await recordDrawOutcome(db, await db.getRow('draw_runs', drawRunId), outcome.status === 'completed' ? { placements: outcome.plan.summary.placements, waitlist: outcome.plan.waitlist.length } : {});
  }
  if (outcome.status !== 'completed') return outcome;
  // Publish the committed placements for public replay (the offer sweep retries this if it fails here).
  const result = protocol ? await guarded(() => publishDrawResult(db, program.$id)) : null;
  // Start the 48 h offer clock as soon as the draw is committed (the sweep retries this if it fails here).
  const offers = await guarded(() => issueOffers(db, program.$id));
  return { status: 'completed' as const, placements: outcome.plan.summary.placements, waitlist: outcome.plan.waitlist.length, result, offers };
}

/** Draw runs that have a seed and are not finished (the seed is set by the freeze/drand step). */
export async function resumableDraws(db: ServerDb) {
  const runs = await allRows(db, 'draw_runs', [Query.equal('status', ['pending', 'running'])]);
  return runs.filter((r) => Boolean(r.seed));
}

/**
 * One failing program or run must not stop the others in the same tick. The
 * result can reach a browser (manual runs, demo draws), so it carries only a
 * safe summary; the full message goes to the Function log (Task 14).
 */
export async function guarded<T>(work: () => Promise<T>): Promise<T | { status: 'error'; detail: string }> {
  try {
    return await work();
  } catch (err) {
    console.error('[guarded]', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return { status: 'error', detail: safeErrorDetail(err) };
  }
}

export function safeErrorDetail(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof ServiceError) return `Database error (${err.mapped.kind}${err.mapped.type ? `: ${err.mapped.type}` : ''}).`;
  return 'Internal error (details are in the Function log).';
}
