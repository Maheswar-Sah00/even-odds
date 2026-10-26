import { Query } from 'node-appwrite';
import { ServiceError } from '../../shared/errors.ts';
import { artifactHash, RESULT_FORMAT, serializeOutcomes, serializeResult, type PublishedResult, type ResultOutcomes } from '../../shared/replay/result.ts';
import { AppError } from './app-error.ts';
import { prepareAudit } from './audit.ts';
import { deterministicId } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { protocolDrawRunId } from './freeze.ts';
import { allRows, findRow, ticketRowId } from './household.ts';
import { sleepBackoff } from './retry.ts';

/**
 * The published draw result (Task 13, docs/REPLAY.md). After a protocol draw
 * completes, the placements the run committed and the waitlist it wrote are
 * READ BACK from the database, mapped to pseudonymous refs and published as
 * canonical JSON (shared/replay/result.ts), together with a `result_published`
 * audit entry, in one transaction. Because the rows are read back rather than
 * copied from the plan, a browser replay that matches this result shows the
 * database holds what the algorithm computed.
 *
 * Outcomes (offer and waitlist status) change after the draw; they are stored
 * beside the result, unhashed, and refreshed by the offers job.
 */

export const drawResultRowId = (programId: string) => deterministicId('rs', 'result', programId);

interface Mapping {
  publicOf: Map<string, string>;
}

async function mapping(db: ServerDb, programId: string): Promise<Mapping> {
  const apps = await allRows(db, 'applications', [Query.equal('program_id', programId)]);
  return { publicOf: new Map(apps.map((a) => [a.family_id, a.public_id])) };
}

const publicIdOf = (m: Mapping, familyId: string) => {
  const id = m.publicOf.get(familyId);
  if (!id) throw new AppError('conflict', 'A committed placement has no application; the result cannot be published.');
  return id;
};

/** The result as the database holds it now, for a completed run. */
export async function buildDrawResult(db: ServerDb, run: Row<'draw_runs'>): Promise<PublishedResult> {
  if (!run.plan_hash) throw new AppError('conflict', 'The draw run has no plan hash.');
  const scope = [Query.equal('program_id', run.program_id)];
  const [m, placements, waitlist] = await Promise.all([
    mapping(db, run.program_id),
    allRows(db, 'placements', [...scope, Query.equal('draw_run_id', run.$id)]),
    allRows(db, 'waitlist', scope),
  ]);
  return {
    format: RESULT_FORMAT,
    programId: run.program_id,
    drawRunId: run.$id,
    inputsHash: run.inputs_hash,
    planHash: run.plan_hash,
    placements: placements.map((p) => {
      if (!p.round) throw new AppError('conflict', 'A draw placement has no round recorded.');
      return { publicId: publicIdOf(m, p.family_id), childRef: ticketRowId(p.program_id, p.child_id), week: p.week, ageGroup: p.age_group, round: p.round };
    }),
    waitlist: waitlist.map((w) => ({ week: w.week, ageGroup: w.age_group, position: w.position, publicId: publicIdOf(m, w.family_id), childRef: ticketRowId(w.program_id, w.child_id) })),
  };
}

/** Current offer and waitlist status per entry (live, not hashed). */
export async function buildOutcomes(db: ServerDb, programId: string, computedAt: Date): Promise<ResultOutcomes> {
  const scope = [Query.equal('program_id', programId)];
  const [m, placements, waitlist] = await Promise.all([mapping(db, programId), allRows(db, 'placements', scope), allRows(db, 'waitlist', scope)]);
  return {
    computedAt: computedAt.toISOString(),
    entries: placements.map((p) => ({ publicId: publicIdOf(m, p.family_id), childRef: ticketRowId(p.program_id, p.child_id), week: p.week, ageGroup: p.age_group, source: p.source ?? 'draw', status: p.status })),
    waitlist: waitlist.map((w) => ({ publicId: publicIdOf(m, w.family_id), childRef: ticketRowId(w.program_id, w.child_id), week: w.week, ageGroup: w.age_group, position: w.position, status: w.status })),
  };
}

export type PublishResultOutcome =
  | { status: 'published' | 'already_published'; resultHash: string; placements: number; waitlist: number }
  | { status: 'not_ready'; reason: string };

/**
 * Publishes the result of a program's completed protocol draw. Idempotent and
 * safe to run concurrently: the row ID is fixed per program, so only one
 * transaction can commit, and every caller then reads that one row.
 */
export async function publishDrawResult(db: ServerDb, programId: string): Promise<PublishResultOutcome> {
  const existing = await findRow(db, 'draw_results', drawResultRowId(programId));
  if (existing) return { status: 'already_published', resultHash: existing.result_hash, placements: existing.placements, waitlist: existing.waitlist };
  const run = await findRow(db, 'draw_runs', protocolDrawRunId(programId));
  if (!run) return { status: 'not_ready', reason: 'No protocol draw run.' };
  if (run.status !== 'completed') return { status: 'not_ready', reason: `The draw run is ${run.status}.` };

  const canonical = serializeResult(await buildDrawResult(db, run));
  const resultHash = artifactHash(canonical);
  const counts = JSON.parse(canonical) as PublishedResult;
  for (let attempt = 1; ; attempt++) {
    const tx = await db.transactions.begin(60);
    try {
      const publishedAt = new Date(tx.$createdAt);
      const outcomes = serializeOutcomes(await buildOutcomes(db, programId, publishedAt));
      await db.createRow(
        'draw_results',
        drawResultRowId(programId),
        {
          program_id: programId,
          format: RESULT_FORMAT,
          canonical,
          result_hash: resultHash,
          draw_run_id: run.$id,
          inputs_hash: run.inputs_hash,
          plan_hash: counts.planHash,
          placements: counts.placements.length,
          waitlist: counts.waitlist.length,
          published_at: publishedAt.toISOString(),
          outcomes,
          outcomes_at: publishedAt.toISOString(),
        },
        { transactionId: tx.$id },
      );
      const { rowId, entry } = await prepareAudit(db, {
        programId,
        event: 'result_published',
        payload: { format: RESULT_FORMAT, result_hash: resultHash, draw_run_id: run.$id, inputs_hash: run.inputs_hash, plan_hash: counts.planHash, placements: counts.placements.length, waitlist: counts.waitlist.length },
      });
      await db.createRow('audit_log', rowId, { program_id: programId, ...entry }, { transactionId: tx.$id });
      await db.transactions.commit(tx.$id);
      return { status: 'published', resultHash, placements: counts.placements.length, waitlist: counts.waitlist.length };
    } catch (err) {
      await db.transactions.rollback(tx.$id).catch(() => undefined);
      const after = await findRow(db, 'draw_results', drawResultRowId(programId));
      if (after) return { status: 'already_published', resultHash: after.result_hash, placements: after.placements, waitlist: after.waitlist };
      // Another audit append took our seq: re-read the head and try again.
      if (!(err instanceof ServiceError && (err.mapped.kind === 'conflict' || err.mapped.kind === 'transaction_conflict')) || attempt >= 5) throw err;
      await sleepBackoff(attempt, { baseDelayMs: 100 });
    }
  }
}

/** Refreshes the live outcomes beside a published result (no-op before it is published). */
export async function refreshResultOutcomes(db: ServerDb, programId: string, at: Date): Promise<boolean> {
  const row = await findRow(db, 'draw_results', drawResultRowId(programId));
  if (!row) return false;
  await db.updateRow('draw_results', row.$id, { outcomes: serializeOutcomes(await buildOutcomes(db, programId, at)), outcomes_at: at.toISOString() });
  return true;
}
