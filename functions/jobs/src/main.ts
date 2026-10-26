import { z } from 'zod';
import { AppError } from '../../shared/app-error.ts';
import { createServerDb } from '../../shared/db.ts';
import { advanceDraw, guarded, resumableDraws } from '../../shared/draw-runner.ts';
import { announceMissingRounds, freezeDuePrograms, resolvePendingBeacons } from '../../shared/freeze.ts';
import { requireEnv, runFunction, type FunctionContext } from '../../shared/function-runtime.ts';
import { assertProduction } from '../../shared/namespace.ts';
import { runOfferSweep } from '../../shared/offers.ts';
import { runOddsJob } from '../../shared/odds-job.ts';
import { requireOrganiser } from '../../shared/organiser.ts';
import { pruneRateLimits } from '../../shared/rate-limit.ts';
import { removeIdleSandboxes } from '../../shared/sandbox.ts';

const manualRun = z.discriminatedUnion('job', [
  z.strictObject({ job: z.literal('odds'), programId: z.string().min(1).max(36).optional() }),
  z.strictObject({ job: z.literal('draw'), drawRunId: z.string().min(1).max(36) }),
  z.strictObject({ job: z.literal('offers'), programId: z.string().min(1).max(36).optional() }),
]);

/** Per invocation; the Function timeout is 120 s. Unfinished draws resume next time. */
const DRAW_BUDGET_MS = 90_000;
/** Whatever the earlier steps leave of the 120 s timeout, minus a margin, goes to the offers sweep (it resumes next run). */
const TICK_DEADLINE_MS = 110_000;
const MIN_OFFERS_BUDGET_MS = 10_000;


/**
 * jobs Function. Runs on a 60-minute interval (the Free plan supports
 * intervals only, not cron, with a 60-minute minimum; Appwrite chooses when
 * within each interval it runs): recomputes published odds, freezes programs
 * whose window has closed, verifies due drand beacons and advances any draw
 * that is ready, then runs the offers sweep (issue, expire, promote; see
 * functions/shared/offers.ts). Organisers can trigger { job: "odds" },
 * { job: "draw", drawRunId } or { job: "offers", programId? } manually.
 * (The Free plan allows only 2 Functions per project, so all scheduled work
 * lives here and all user requests live in the api Function.)
 */
export default (ctx: FunctionContext) =>
  runFunction(ctx, async ({ userId, body, aw }) => {
    const db = createServerDb(aw);
    const started = Date.now();
    const offersDeadline = () => Math.max(started + TICK_DEADLINE_MS, Date.now() + MIN_OFFERS_BUDGET_MS);
    if (ctx.req.headers['x-appwrite-trigger'] === 'schedule') {
      const odds = await guarded(() => runOddsJob(db));
      const announced = await guarded(() => announceMissingRounds(db));
      const frozen = await guarded(() => freezeDuePrograms(db));
      const beacons = await guarded(() => resolvePendingBeacons(db));
      const draws: Record<string, unknown> = {};
      for (const r of await resumableDraws(db)) draws[r.$id] = await guarded(() => advanceDraw(db, r.$id, { budgetMs: DRAW_BUDGET_MS }));
      const offers = await guarded(() => runOfferSweep(db, { deadline: offersDeadline() }));
      const sandboxes = await guarded(() => removeIdleSandboxes(aw, db));
      const rateLimits = await guarded(() => pruneRateLimits(db));
      return { odds, announced, frozen, beacons, draws, offers, sandboxes, rateLimits };
    }
    if (!userId) throw new AppError('unauthorized', 'Please sign in.');
    await requireOrganiser(aw.teams, requireEnv('APPWRITE_ORGANISER_TEAM_ID'), userId);
    const request = manualRun.parse(body);
    // Manual runs are production-only; demo sandboxes are driven by the api "demo" area.
    const programId = request.job === 'draw' ? (await db.getRow('draw_runs', request.drawRunId)).program_id : request.programId;
    if (programId) assertProduction(await db.getRow('programs', programId));
    if (request.job === 'odds') return runOddsJob(db, new Date(), request.programId ? [request.programId] : undefined);
    if (request.job === 'offers') return runOfferSweep(db, { deadline: offersDeadline(), ...(request.programId ? { programId: request.programId } : {}) });
    return advanceDraw(db, request.drawRunId, { budgetMs: DRAW_BUDGET_MS });
  });
