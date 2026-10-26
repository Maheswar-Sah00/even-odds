import { fairnessReport, familiesFromInputs, type FairnessReport, type FairnessSession } from '@shared/fairness.ts';
import type { ReplayStep, Verification } from '@shared/replay/replay.ts';

/**
 * Builds the public fairness report from a replay Verification
 * (shared/replay/replay.ts). Only artifacts whose own hashes this browser
 * has just checked are used: the frozen inputs, the application order
 * committed at freeze, and the published result. Offer outcomes and
 * offer_stats are live and unhashed; they are labelled as such wherever
 * they appear. No number on the page comes from anywhere else.
 */

/** offer_stats columns the report reads: capacity and seats held now, per session. */
export interface OfferStatsRow {
  week: string;
  age_group: string;
  capacity: number;
  taken: number;
  computed_at?: string;
}

export type FairnessData =
  | { ready: false; reason: string; steps: ReplayStep[] }
  | {
      ready: true;
      report: FairnessReport;
      steps: ReplayStep[];
      inputsHash: string;
      /** SHA-256 of the canonical result file, recomputed here. */
      resultHash: string | null;
      orderCommittedAtFreeze: boolean;
      replayMatches: boolean | null;
      outcomesAt: string | null;
      offerStatsAt: string | null;
      ms: number;
    };

/** The verification steps the report depends on, in protocol order. */
export const SOURCE_STEPS: ReplayStep['key'][] = ['audit', 'inputs', 'inputs_hash', 'order', 'result', 'compare'];

export function buildFairness(v: Verification, offerStats: readonly OfferStatsRow[] = [], opts: { resultHash?: string | null; permutations?: number } = {}): FairnessData {
  const steps = v.steps.filter((s) => SOURCE_STEPS.includes(s.key));
  const failed = steps.find((s) => s.status === 'fail');
  if (!v.inputs || !v.inputsHash) return { ready: false, reason: failed ? `${failed.title}: ${failed.summary}` : 'The inputs have not been frozen yet, so there is nothing to report on.', steps };
  if (!v.result) {
    const resultStep = steps.find((s) => s.key === 'result');
    return { ready: false, reason: resultStep && resultStep.status !== 'pass' ? `${resultStep.title}: ${resultStep.summary}` : 'No verified result has been published yet. The report appears once the draw is complete.', steps };
  }

  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const currentSessions: FairnessSession[] = offerStats.map((s) => ({ week: s.week, ageGroup: s.age_group, capacity: s.capacity, taken: s.taken }));
  const report = fairnessReport({
    families: familiesFromInputs(v.inputs),
    placements: v.result.placements.map((p) => ({ publicId: p.publicId, childRef: p.childRef, week: p.week, ageGroup: p.ageGroup })),
    sessions: v.inputs.sessions,
    currentSessions,
    ...(v.applicationOrder ? { applicationOrder: v.applicationOrder.order } : {}),
    outcomes: v.outcomes ? { entries: v.outcomes.entries, waitlist: v.outcomes.waitlist } : null,
    maxWeeks: v.inputs.maxWeeks,
    testSeed: v.inputsHash,
    ...(opts.permutations ? { permutations: opts.permutations } : {}),
  });
  const latest = offerStats.map((s) => s.computed_at).filter((x): x is string => !!x).sort().at(-1) ?? null;
  return {
    ready: true,
    report,
    steps,
    inputsHash: v.inputsHash,
    resultHash: opts.resultHash ?? null,
    orderCommittedAtFreeze: !!v.applicationOrder,
    replayMatches: v.replayMatches,
    outcomesAt: v.outcomes?.computedAt ?? null,
    offerStatsAt: latest,
    ms: typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : 0,
  };
}
