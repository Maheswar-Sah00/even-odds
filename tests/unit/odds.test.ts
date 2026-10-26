// @vitest-environment node
/** The odds estimator on small datasets with known outcomes. Seeded, so results are reproducible. */
import { describe, expect, it } from 'vitest';
import { bandOf, estimateOdds, simulateOnce, mulberry32, hashSeed, type OddsApplicant, type OddsInput } from '../../shared/odds.ts';

const child = (weeks: string[], requested = 1, group = 'g') => ({ rankedWeeks: weeks, ageGroups: weeks.map(() => group), requested });
const app = (publicId: string, tier: number, children = [child(['W1'])], opts: Partial<OddsApplicant> = {}): OddsApplicant => ({ publicId, tier, late: false, siblingMode: 'independent', children, ...opts });
const seats = (spec: Record<string, number>, group = 'g') => Object.entries(spec).map(([week, capacity]) => ({ week, ageGroup: group, capacity }));
const est = (input: OddsInput, iterations = 2000, seed = 'test') => estimateOdds(input, { iterations, seed });
const tierP = (r: ReturnType<typeof estimateOdds>, t: number) => r.tiers.find((x) => x.tier === t)?.pAtLeastOne;
const many = (n: number, prefix: string, tier: number, extra: Partial<OddsApplicant> = {}) => Array.from({ length: n }, (_, i) => app(`${prefix}${String(i).padStart(3, '0')}`, tier, [child(['W1'])], extra));

describe('known outcomes', () => {
  it('enough seats for everyone: certain', () => {
    expect(tierP(est({ maxWeeks: 1, seats: seats({ W1: 10 }), applicants: many(6, 'a', 0) }), 0)).toBe(1);
  });

  it('no seats: impossible', () => {
    expect(tierP(est({ maxWeeks: 1, seats: seats({ W1: 0 }), applicants: many(6, 'a', 0) }), 0)).toBe(0);
  });

  it('3 seats for 6 equal applicants: about one half', () => {
    const p = tierP(est({ maxWeeks: 1, seats: seats({ W1: 3 }), applicants: many(6, 'a', 0) }), 0) ?? -1;
    expect(p).toBeCloseTo(0.5, 5); // exactly 3 of 6 every time
  });

  it('a better tier is always served first', () => {
    const r = est({ maxWeeks: 1, seats: seats({ W1: 5 }), applicants: [...many(5, 'a', 0), ...many(5, 'b', 1)] });
    expect(tierP(r, 0)).toBe(1);
    expect(tierP(r, 1)).toBe(0);
  });

  it('late applicants come after on-time applicants in the same tier', () => {
    const simulated = simulateOnce({ maxWeeks: 1, seats: seats({ W1: 1 }), applicants: [app('late', 0, [child(['W1'])], { late: true }), app('ontime', 0)] }, mulberry32(1));
    expect(simulated).toEqual([[[]], [['W1']]]);
  });

  it('together-only siblings are placed as a unit or not at all', () => {
    const kids = [child(['W1'], 1, 'young'), child(['W1'], 1, 'old')];
    const input = (mode: OddsApplicant['siblingMode']): OddsInput => ({
      maxWeeks: 1,
      seats: [{ week: 'W1', ageGroup: 'young', capacity: 1 }, { week: 'W1', ageGroup: 'old', capacity: 0 }],
      applicants: [app('fam', 0, kids, { siblingMode: mode })],
    });
    expect(simulateOnce(input('together_only'), mulberry32(1))).toEqual([[[], []]]);
    expect(simulateOnce(input('together_preferred'), mulberry32(1))).toEqual([[['W1'], []]]);
    expect(simulateOnce(input('independent'), mulberry32(1))).toEqual([[['W1'], []]]);
  });

  it('together-only picks the first common week with room for all', () => {
    const kids = [child(['W1', 'W2'], 1, 'g'), child(['W2', 'W1'], 1, 'g')];
    const r = simulateOnce({ maxWeeks: 1, seats: seats({ W1: 1, W2: 2 }), applicants: [app('fam', 0, kids, { siblingMode: 'together_only' })] }, mulberry32(1));
    expect(r).toEqual([[['W2'], ['W2']]]); // W1 has only one seat
  });

  it('snake draft: everyone gets a first week before anyone gets a second', () => {
    const input: OddsInput = { maxWeeks: 2, seats: seats({ W1: 1, W2: 1 }), applicants: [app('a', 0, [child(['W1', 'W2'], 2)]), app('b', 0, [child(['W1', 'W2'], 2)])] };
    for (let s = 0; s < 20; s++) {
      const r = simulateOnce(input, mulberry32(s));
      expect(r.map((x) => x[0]?.length)).toEqual([1, 1]);
    }
  });

  it('never exceeds capacity in any session (random instances)', () => {
    for (let s = 0; s < 50; s++) {
      const rng = mulberry32(1000 + s);
      const weeks = ['W1', 'W2', 'W3'];
      const capacity = Object.fromEntries(weeks.map((w) => [w, Math.floor(rng() * 4)]));
      const applicants = Array.from({ length: 12 }, (_, i) =>
        app(`p${String(i)}`, Math.floor(rng() * 2), Array.from({ length: 1 + Math.floor(rng() * 3) }, () => child([...weeks].sort(() => rng() - 0.5).slice(0, 1 + Math.floor(rng() * 3)), 1 + Math.floor(rng() * 2))), {
          siblingMode: (['together_only', 'together_preferred', 'independent'] as const)[Math.floor(rng() * 3)] ?? 'independent',
        }),
      );
      const result = simulateOnce({ maxWeeks: 2, seats: seats(capacity), applicants }, rng);
      for (const w of weeks) {
        const placed = result.flat().filter((ws) => ws.includes(w)).length;
        expect(placed).toBeLessThanOrEqual(capacity[w] ?? 0);
      }
      // No child holds a week twice or more weeks than requested.
      result.forEach((kids, ai) => {
        kids.forEach((ws, ci) => {
          expect(new Set(ws).size).toBe(ws.length);
          expect(ws.length).toBeLessThanOrEqual(applicants[ai]?.children[ci]?.requested ?? 0);
        });
      });
    }
  });
});

describe('reproducibility, uncertainty and fairness', () => {
  const input: OddsInput = { maxWeeks: 1, seats: seats({ W1: 4 }), applicants: [...many(6, 'a', 0), ...many(6, 'b', 0)] };

  it('the same seed gives the same estimate; a different seed gives a close one', () => {
    expect(est(input, 500, 's1')).toEqual(est(input, 500, 's1'));
    expect(Math.abs((tierP(est(input, 2000, 's1'), 0) ?? 0) - (tierP(est(input, 2000, 's2'), 0) ?? 0))).toBeLessThan(0.02);
  });

  it('reports a confidence interval around the estimate', () => {
    const t = est({ maxWeeks: 1, seats: seats({ W1: 1 }), applicants: [...many(3, 'a', 0), ...many(3, 'x', 0)] }).tiers[0];
    expect(t?.ciLow).toBeLessThanOrEqual(t?.pAtLeastOne ?? 0);
    expect(t?.ciHigh).toBeGreaterThanOrEqual(t?.pAtLeastOne ?? 1);
  });

  it('input order (and so submission time) cannot change the estimate', () => {
    const shuffled = { ...input, applicants: [...input.applicants].reverse() };
    expect(est(shuffled, 300, 'x')).toEqual(est(input, 300, 'x'));
  });

  it('suppresses tiers too small to publish without privacy risk', () => {
    const r = est({ maxWeeks: 1, seats: seats({ W1: 1 }), applicants: [...many(6, 'a', 0), ...many(2, 'b', 1)] });
    expect(r.tiers.find((t) => t.tier === 1)).toMatchObject({ children: 2, pAtLeastOne: null, band: null });
  });

  it('reports demand per seat for each session', () => {
    const r = est({ maxWeeks: 1, seats: seats({ W1: 2, W2: 0 }), applicants: [app('a', 0, [child(['W1', 'W2'])]), app('b', 0, [child(['W2', 'W1'])])] }, 10);
    expect(r.sessions).toEqual([
      { week: 'W1', ageGroup: 'g', capacity: 2, firstChoice: 1, totalRanked: 2, demandPerSeat: 1 },
      { week: 'W2', ageGroup: 'g', capacity: 0, firstChoice: 1, totalRanked: 2, demandPerSeat: null },
    ]);
  });

  it('bands are labelled ranges, not precise percentages', () => {
    expect([0.95, 0.7, 0.5, 0.3, 0.1].map(bandOf)).toEqual(['Very likely', 'Likely', 'About even', 'Unlikely', 'Very unlikely']);
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });
});
