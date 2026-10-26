/**
 * Task 13: the fairness report card (shared/fairness.ts). Every number is
 * computed from the data it is given; these tests feed it fixtures and real
 * draws from the shared draw module.
 */
import { describe, expect, it } from 'vitest';
import { computePlan, type DrawInputs, type DrawPlan } from '../../shared/draw/index.ts';
import { SAMPLE_INPUTS, SAMPLE_SEED } from '../../shared/draw/sample.ts';
import { sha256Hex } from '../../shared/draw/sha256.ts';
import { fairnessReport, familiesFromInputs, firstComeAllocation, stratifiedPermutationTest, submissionQuartiles, wilson, type FairnessFamily, type FairnessPlacement } from '../../shared/fairness.ts';

const fam = (publicId: string, submittedAt: string, children: number, mode: FairnessFamily['siblingMode'] = 'independent', tier = 1): FairnessFamily => ({
  publicId,
  tier,
  siblingMode: mode,
  submittedAt,
  children: Array.from({ length: children }, (_, i) => ({ ref: `${publicId}-c${String(i)}`, rankedWeeks: ['W1'], ageGroups: ['A'], requested: 1 })),
});
const at = (id: string, childRef: string, week = 'W1', ageGroup = 'A'): FairnessPlacement => ({ publicId: id, childRef, week, ageGroup });

const placementsOf = (plan: DrawPlan): FairnessPlacement[] => plan.steps.flatMap((s) => s.placements.map((p) => ({ publicId: s.publicId, ...p })));

/** A SYNTHETIC oversubscribed program: deterministic from `label`, submission order independent of everything else. */
function syntheticProgram(label: string, families = 160): { inputs: DrawInputs; order: string[] } {
  let counter = 0;
  const rand = () => parseInt(sha256Hex(`${label}:${String(counter++)}`).slice(0, 8), 16) / 2 ** 32;
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const weeks = ['W1', 'W2', 'W3', 'W4'];
  const applications: DrawInputs['applications'] = Array.from({ length: families }, (_, i) => {
    const publicId = `syn${String(i).padStart(4, '0')}`;
    const size = rand() < 0.6 ? 1 : rand() < 0.75 ? 2 : 3;
    const ranked = [...weeks].sort(() => rand() - 0.5).slice(0, 2 + Math.floor(rand() * 3));
    return {
      publicId,
      tier: pick([0, 1, 1, 2]),
      late: rand() < 0.05,
      siblingMode: size === 1 ? 'independent' : pick(['together_only', 'together_preferred', 'independent'] as const),
      children: Array.from({ length: size }, (_, c) => {
        const group = rand() < 0.5 ? 'A' : 'B';
        return { ref: `${publicId}-k${String(c)}`, rankedWeeks: ranked, ageGroups: ranked.map(() => group), requested: rand() < 0.7 ? 1 : 2 };
      }),
    };
  });
  const order = applications.map((a) => a.publicId).sort(() => rand() - 0.5);
  return {
    inputs: { schema: 'draw-inputs-v1', algorithm: 'even-odds-draw-v1', programId: label, maxWeeks: 2, sessions: weeks.flatMap((week) => ['A', 'B'].map((ageGroup) => ({ week, ageGroup, capacity: 20 }))), applications, overrides: [] },
    order,
  };
}

describe('fairness report: invariants', () => {
  const families = [fam('p1', '2026-01-01T00:00:00Z', 1), fam('p2', '2026-01-02T00:00:00Z', 2, 'together_only'), fam('p3', '2026-01-03T00:00:00Z', 1), fam('p4', '2026-01-04T00:00:00Z', 1, 'independent', 0)];
  const sessions = [{ week: 'W1', ageGroup: 'A', capacity: 2, taken: 2 }];

  it('is all zero for a valid allocation', () => {
    const r = fairnessReport({ families, sessions, placements: [at('p2', 'p2-c0'), at('p2', 'p2-c1')], permutations: 50 });
    expect(r.invariants).toEqual({ oversoldSessions: [], oversoldSeats: 0, duplicatePlacements: 0, overRequested: 0, unexplainedPlacements: 0, siblingSplits: 0, togetherOnlyFamilies: 1 });
  });

  it('flags a split together-only family, oversold seats, duplicates and placements the inputs cannot explain', () => {
    expect(fairnessReport({ families, sessions, placements: [at('p2', 'p2-c0')], permutations: 10 }).invariants.siblingSplits).toBe(1);
    const over = fairnessReport({ families, sessions, placements: [at('p1', 'p1-c0'), at('p3', 'p3-c0'), at('p4', 'p4-c0')], permutations: 10 });
    expect(over.invariants.oversoldSessions).toEqual([{ week: 'W1', ageGroup: 'A', capacity: 2, taken: 3 }]);
    expect(over.invariants.oversoldSeats).toBe(1);
    // Seats held now (ledger / offer_stats) beyond capacity also count.
    expect(fairnessReport({ families, sessions, currentSessions: [{ week: 'W1', ageGroup: 'A', capacity: 2, taken: 4 }], placements: [], permutations: 10 }).invariants.oversoldSeats).toBe(2);
    const dup = fairnessReport({ families, sessions: [{ week: 'W1', ageGroup: 'A', capacity: 9 }], placements: [at('p1', 'p1-c0'), at('p1', 'p1-c0')], permutations: 10 });
    expect(dup.invariants.duplicatePlacements).toBe(1);
    const odd = fairnessReport({ families, sessions, placements: [at('p1', 'p1-c0', 'W1', 'B'), at('p1', 'ghost'), at('p3', 'p1-c0')], permutations: 10 });
    expect(odd.invariants.unexplainedPlacements).toBe(3);
  });

  it('does not count a sibling as split once their own request is met', () => {
    const f: FairnessFamily = {
      publicId: 'q',
      tier: 1,
      siblingMode: 'together_only',
      children: [
        { ref: 'q1', rankedWeeks: ['W1', 'W2'], ageGroups: ['A', 'A'], requested: 1 },
        { ref: 'q2', rankedWeeks: ['W1', 'W2'], ageGroups: ['A', 'A'], requested: 2 },
      ],
    };
    const s = [{ week: 'W1', ageGroup: 'A', capacity: 5 }, { week: 'W2', ageGroup: 'A', capacity: 5 }];
    expect(fairnessReport({ families: [f], sessions: s, placements: [at('q', 'q1'), at('q', 'q2'), at('q', 'q2', 'W2')], permutations: 10 }).invariants.siblingSplits).toBe(0);
    expect(fairnessReport({ families: [f], sessions: s, placements: [at('q', 'q2'), at('q', 'q2', 'W2')], permutations: 10 }).invariants.siblingSplits).toBe(1);
  });

  it('is all zero for real draws from the shared draw module', () => {
    const plan = computePlan(SAMPLE_INPUTS, SAMPLE_SEED);
    const r = fairnessReport({ families: familiesFromInputs(SAMPLE_INPUTS), placements: placementsOf(plan), sessions: SAMPLE_INPUTS.sessions, maxWeeks: SAMPLE_INPUTS.maxWeeks, applicationOrder: ['f6', 'a1', 'b2', 'c3', 'd4', 'e5'], permutations: 50 });
    expect(r.invariants).toMatchObject({ oversoldSeats: 0, duplicatePlacements: 0, overRequested: 0, unexplainedPlacements: 0, siblingSplits: 0, togetherOnlyFamilies: 1 });
    expect(r.families).toBe(5); // the withdrawn family takes no part
    expect(r.drawPlacements).toBe(plan.summary.placements);
    expect(r.childrenWithAWeek).toBe(plan.summary.childrenWithAWeek);
    for (const label of ['a', 'b', 'c']) {
      const { inputs } = syntheticProgram(label, 120);
      const p = computePlan(inputs, sha256Hex(label));
      const rep = fairnessReport({ families: familiesFromInputs(inputs), placements: placementsOf(p), sessions: inputs.sessions, maxWeeks: inputs.maxWeeks, permutations: 10 });
      expect(rep.invariants).toMatchObject({ oversoldSeats: 0, duplicatePlacements: 0, overRequested: 0, unexplainedPlacements: 0, siblingSplits: 0 });
      expect(rep.drawPlacements).toBe(p.summary.placements);
    }
  });
});

describe('fairness report: rates and first come', () => {
  const families = [fam('p1', '2026-01-01T00:00:00Z', 1), fam('p2', '2026-01-02T00:00:00Z', 2, 'together_only'), fam('p3', '2026-01-03T00:00:00Z', 1), fam('p4', '2026-01-04T00:00:00Z', 1, 'independent', 0)];
  const sessions = [{ week: 'W1', ageGroup: 'A', capacity: 2 }];

  it('counts families and children per group, with sample sizes and intervals', () => {
    const r = fairnessReport({ families, sessions, placements: [at('p4', 'p4-c0'), at('p3', 'p3-c0')], permutations: 10 });
    expect(r.bySize.map((g) => [g.group, g.families, g.placed, g.children, g.childrenPlaced])).toEqual([['1 child', 3, 2, 3, 2], ['2 children', 1, 0, 2, 0]]);
    expect(r.byTier.map((g) => [g.group, g.families, g.rate])).toEqual([['Tier 0', 1, 1], ['Tier 1', 3, 1 / 3]]);
    expect(r.byApplicationTime.map((g) => g.placed)).toEqual([0, 0, 1, 1]);
    const tier1 = r.byTier[1];
    expect(tier1?.low).toBeLessThan(1 / 3);
    expect(tier1?.high).toBeGreaterThan(1 / 3);
    expect(r.applicationOrder).toEqual({ source: 'submission_times', missing: 0, extra: 0 });
  });

  it('uses a published order over timestamps, and reports families missing from it', () => {
    const q = submissionQuartiles(families, ['p4', 'p3', 'p2', 'zz']);
    expect([q.get('p4'), q.get('p3'), q.get('p2'), q.get('p1')]).toEqual(['1st quarter (earliest)', '2nd quarter', '3rd quarter', 'Unknown']);
    const r = fairnessReport({ families, sessions, placements: [], applicationOrder: ['p4', 'p3', 'p2', 'zz'], permutations: 10 });
    expect(r.applicationOrder).toEqual({ source: 'published_order', missing: 1, extra: 1 });
  });

  it('computes no time groups or first-come baseline when no order is known, rather than guessing one', () => {
    const untimed = families.map(({ submittedAt: _drop, ...f }) => f);
    const r = fairnessReport({ families: untimed, sessions, placements: [at('p1', 'p1-c0')], permutations: 10 });
    expect(r.applicationOrder.source).toBe('none');
    expect(r.firstCome).toBeNull();
    expect(r.byApplicationTime.map((g) => g.group)).toEqual(['Unknown']);
    expect(r.tests.map((t) => t.key)).toEqual(['application_time', 'family_size']);
    expect(r.tests[0]?.status).toBe('not_meaningful');
  });

  it('first come keeps priority and sibling rules: a together-only pair is never split to fit', () => {
    // Tier 0 first (p4), then p1; p2 needs two seats in W1 and only one is left, so it gets none.
    expect(firstComeAllocation(families, sessions).map((p) => p.publicId)).toEqual(['p4', 'p1']);
    const r = fairnessReport({ families, sessions, placements: [], permutations: 10 });
    expect(r.firstCome).toMatchObject({ placements: 2, familiesWithAWeek: 2, siblingSplits: 0 });
    expect(r.firstCome?.byApplicationTime.map((g) => g.placed)).toEqual([1, 0, 0, 1]);
  });

  it('first come never oversells, duplicates or exceeds a request on a large program', () => {
    const { inputs, order } = syntheticProgram('fc', 160);
    const fc = firstComeAllocation(familiesFromInputs(inputs), inputs.sessions, { applicationOrder: order, maxWeeks: inputs.maxWeeks });
    const r = fairnessReport({ families: familiesFromInputs(inputs), placements: fc, sessions: inputs.sessions, maxWeeks: inputs.maxWeeks, applicationOrder: order, permutations: 10 });
    expect(r.invariants).toMatchObject({ oversoldSeats: 0, duplicatePlacements: 0, overRequested: 0, unexplainedPlacements: 0, siblingSplits: 0 });
    expect(r.firstCome?.placements).toBe(fc.length);
  });

  it('Wilson intervals behave at the edges', () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(10, 10).high).toBeCloseTo(1, 12);
    const w = wilson(50, 100);
    expect(w.low).toBeCloseTo(0.4038, 3);
    expect(w.high).toBeCloseTo(0.5962, 3);
  });
});

describe('fairness report: bias tests', () => {
  it('does not claim anything when the test cannot be meaningful', () => {
    const tiny = [fam('a', '1', 1), fam('b', '2', 1), fam('c', '3', 1)];
    const r = fairnessReport({ families: tiny, sessions: [{ week: 'W1', ageGroup: 'A', capacity: 1 }], placements: [at('a', 'a-c0')], permutations: 50 });
    expect(r.tests.every((t) => t.status === 'not_meaningful' && t.pValue === null && t.reason)).toBe(true);
    // Everybody placed: no variation to explain.
    const all = Array.from({ length: 20 }, (_, i) => fam(`f${String(i)}`, String(i).padStart(3, '0'), 1));
    const everyone = fairnessReport({ families: all, sessions: [{ week: 'W1', ageGroup: 'A', capacity: 20 }], placements: all.map((f) => at(f.publicId, `${f.publicId}-c0`)), permutations: 50 });
    expect(everyone.tests[0]).toMatchObject({ status: 'not_meaningful', informativeFamilies: 0 });
  });

  it('only compares families within the same priority group', () => {
    // Tier 0 all placed, tier 1 none: a pure policy difference, perfectly correlated with time. Not evidence of a head start.
    const families = Array.from({ length: 40 }, (_, i) => fam(`f${String(i).padStart(2, '0')}`, String(i).padStart(3, '0'), 1, 'independent', i < 20 ? 0 : 1));
    const placed = new Set(families.filter((f) => f.tier === 0).map((f) => f.publicId));
    const t = stratifiedPermutationTest({ key: 'application_time', question: 'q', families, placed, groupOf: (f) => (f.publicId < 'f20' ? 'early' : 'late'), permutations: 200, seed: 's' });
    expect(t.status).toBe('not_meaningful');
  });

  it('is deterministic for a given seed', () => {
    const { inputs, order } = syntheticProgram('det', 120);
    const placements = placementsOf(computePlan(inputs, sha256Hex('det')));
    const run = (seed: string) => fairnessReport({ families: familiesFromInputs(inputs), placements, sessions: inputs.sessions, maxWeeks: 2, applicationOrder: order, permutations: 300, testSeed: seed }).tests.map((t) => t.pValue);
    expect(run('x')).toEqual(run('x'));
  });

  it('is calibrated on real lottery draws and detects the head start of first come', () => {
    const pLottery: number[] = [];
    for (let i = 0; i < 12; i++) {
      const { inputs, order } = syntheticProgram(`cal${String(i)}`, 160);
      const plan = computePlan(inputs, sha256Hex(`seed${String(i)}`));
      const r = fairnessReport({ families: familiesFromInputs(inputs), placements: placementsOf(plan), sessions: inputs.sessions, maxWeeks: inputs.maxWeeks, applicationOrder: order, permutations: 400, testSeed: plan.inputsHash });
      const [time, , firstCome] = r.tests;
      expect(time?.status).toBe('tested');
      pLottery.push(time?.pValue ?? 0);
      // First come on the same data: earlier families are served first, which the test sees.
      expect(firstCome?.status).toBe('tested');
      expect(firstCome?.pValue).toBeLessThan(0.01);
      expect(r.firstCome?.byApplicationTime[0]?.rate).toBeGreaterThan(r.firstCome?.byApplicationTime[3]?.rate ?? 1);
    }
    // Under a lottery, application time is independent of the outcome: p-values are not concentrated near 0.
    expect(pLottery.filter((p) => p < 0.05).length).toBeLessThanOrEqual(3);
  });
});

describe('fairness report: outcomes', () => {
  it('counts offers by source and status, seats held and waitlist movement', () => {
    const families = [fam('p1', '1', 1), fam('p2', '2', 1), fam('p3', '3', 1)];
    const r = fairnessReport({
      families,
      sessions: [{ week: 'W1', ageGroup: 'A', capacity: 2 }],
      placements: [at('p1', 'p1-c0'), at('p2', 'p2-c0')],
      permutations: 10,
      outcomes: {
        entries: [
          { ...at('p1', 'p1-c0'), source: 'draw', status: 'accepted' },
          { ...at('p2', 'p2-c0'), source: 'draw', status: 'declined' },
          { ...at('p3', 'p3-c0'), source: 'waitlist', status: 'offered' },
        ],
        waitlist: [{ ...at('p3', 'p3-c0'), position: 1, status: 'promoted' }],
      },
    });
    expect(r.outcomes?.offers).toEqual([
      { source: 'draw', total: 2, byStatus: { offered: 0, accepted: 1, declined: 1, expired: 0, released: 0, cancelled: 0 } },
      { source: 'waitlist', total: 1, byStatus: { offered: 1, accepted: 0, declined: 0, expired: 0, released: 0, cancelled: 0 } },
    ]);
    expect(r.outcomes).toMatchObject({ seatsHeld: 2, answered: 2, accepted: 1, waitlist: { total: 1, children: 1, byStatus: { waiting: 0, promoted: 1, removed: 0 } } });
    expect(r.outcomes?.acceptedByApplicationTime.reduce((n, g) => n + g.placed, 0)).toBe(1);
  });

  it('is null when no outcomes are published', () => {
    expect(fairnessReport({ families: [], sessions: [], placements: [], permutations: 10 }).outcomes).toBeNull();
  });
});
