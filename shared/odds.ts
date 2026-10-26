/**
 * Odds estimator (Monte Carlo). VERSIONED: any change to the model below must
 * bump ODDS_MODEL_VERSION. This is deliberately NOT the real draw: it uses a
 * seeded pseudo-random order instead of the drand seed, and exists only to
 * estimate chances while applications are open. The real, deterministic,
 * replayable draw lives in shared/draw (Task 9).
 *
 * Model (odds-v1), mirroring the published draw rules (docs/DRAW-ALGORITHM.md):
 *  1. Applicants are ordered by tier (lower first), then on-time before late,
 *     then uniformly at random. Submission time is not an input.
 *  2. Snake draft over R = max_weeks rounds: odd rounds forward, even rounds
 *     reversed. In each round a family can gain at most one more week per child,
 *     and only children who still want more weeks (requested) take part.
 *  3. Capacity is per (week, age group). A child never holds the same week twice.
 *  4. Sibling modes, per family per round, for the children still taking part:
 *     - together_only: the first week (by summed rank across those children) that
 *       they all ranked, none holds, and that has seats for all of them in their
 *       age groups; placed all-or-nothing.
 *     - together_preferred: as together_only; if no such week, each child is then
 *       placed independently.
 *     - independent: each child takes their highest-ranked week with a free seat.
 */

export const ODDS_MODEL_VERSION = 'odds-v1';
export const MIN_PUBLISHABLE_GROUP = 5;

export type SiblingMode = 'together_only' | 'together_preferred' | 'independent';

export interface OddsChild {
  rankedWeeks: readonly string[];
  /** Age group for each ranked week (same length as rankedWeeks). */
  ageGroups: readonly string[];
  requested: number;
}

export interface OddsApplicant {
  /** Pseudonymous; used only to put applicants in a canonical order. */
  publicId: string;
  tier: number;
  late: boolean;
  siblingMode: SiblingMode;
  children: readonly OddsChild[];
}

export interface OddsSeat {
  week: string;
  ageGroup: string;
  capacity: number;
}

export interface OddsInput {
  maxWeeks: number;
  seats: readonly OddsSeat[];
  applicants: readonly OddsApplicant[];
}

// ---- Seeded PRNG ----------------------------------------------------------------

/** FNV-1a 32-bit string hash, for turning a seed string into PRNG state. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for Monte Carlo estimates (not for the real draw). */
export function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- One simulated draw ---------------------------------------------------------

const seatKey = (week: string, ageGroup: string) => `${week}\u0000${ageGroup}`;

/** Returns, for each applicant (in input order) and child, the weeks placed in one simulated draw. */
export function simulateOnce(input: OddsInput, rng: () => number): string[][][] {
  const remaining = new Map(input.seats.map((s) => [seatKey(s.week, s.ageGroup), s.capacity]));
  const held: Set<string>[][] = input.applicants.map((a) => a.children.map(() => new Set<string>()));
  const keys = input.applicants.map(() => rng());
  const order = input.applicants
    .map((_a, i) => i)
    .sort((i, j) => {
      const a = input.applicants[i];
      const b = input.applicants[j];
      if (!a || !b) return 0;
      return a.tier - b.tier || Number(a.late) - Number(b.late) || (keys[i] ?? 0) - (keys[j] ?? 0);
    });

  const groupOf = (c: OddsChild, week: string) => c.ageGroups[c.rankedWeeks.indexOf(week)] ?? '';
  const free = (week: string, group: string) => (remaining.get(seatKey(week, group)) ?? 0) > 0;
  const take = (week: string, group: string) => {
    remaining.set(seatKey(week, group), (remaining.get(seatKey(week, group)) ?? 0) - 1);
  };

  const placeIndependently = (ai: number, ci: number) => {
    const child = input.applicants[ai]?.children[ci];
    const mine = held[ai]?.[ci];
    if (!child || !mine) return;
    for (const week of child.rankedWeeks) {
      const group = groupOf(child, week);
      if (!mine.has(week) && free(week, group)) {
        take(week, group);
        mine.add(week);
        return;
      }
    }
  };

  const placeTogether = (ai: number, active: number[]): boolean => {
    const app = input.applicants[ai];
    if (!app) return false;
    const kids = active.map((ci) => app.children[ci]).filter((c): c is OddsChild => c !== undefined);
    const first = kids[0];
    if (!first) return false;
    const candidates = first.rankedWeeks
      .filter((w) => kids.every((k) => k.rankedWeeks.includes(w)) && active.every((ci) => !held[ai]?.[ci]?.has(w)))
      .map((w, idx) => ({ w, score: kids.reduce((n, k) => n + k.rankedWeeks.indexOf(w), 0), idx }))
      .sort((x, y) => x.score - y.score || x.idx - y.idx);
    for (const { w } of candidates) {
      const need = new Map<string, number>();
      for (const k of kids) need.set(groupOf(k, w), (need.get(groupOf(k, w)) ?? 0) + 1);
      if ([...need].every(([g, n]) => (remaining.get(seatKey(w, g)) ?? 0) >= n)) {
        for (const [g, n] of need) remaining.set(seatKey(w, g), (remaining.get(seatKey(w, g)) ?? 0) - n);
        for (const ci of active) held[ai]?.[ci]?.add(w);
        return true;
      }
    }
    return false;
  };

  for (let round = 1; round <= input.maxWeeks; round++) {
    const sequence = round % 2 === 1 ? order : [...order].reverse();
    for (const ai of sequence) {
      const app = input.applicants[ai];
      if (!app) continue;
      const active = app.children.map((_c, ci) => ci).filter((ci) => (held[ai]?.[ci]?.size ?? 0) < Math.min(app.children[ci]?.requested ?? 0, input.maxWeeks));
      if (active.length === 0) continue;
      if (active.length === 1 || app.siblingMode === 'independent') {
        for (const ci of active) placeIndependently(ai, ci);
      } else if (!placeTogether(ai, active) && app.siblingMode === 'together_preferred') {
        for (const ci of active) placeIndependently(ai, ci);
      }
    }
  }
  return held.map((kids) => kids.map((s) => [...s]));
}

// ---- Estimate -------------------------------------------------------------------

export const BANDS = [
  { min: 0.8, label: 'Very likely' },
  { min: 0.6, label: 'Likely' },
  { min: 0.4, label: 'About even' },
  { min: 0.2, label: 'Unlikely' },
  { min: 0, label: 'Very unlikely' },
] as const;

export function bandOf(p: number): string {
  return BANDS.find((b) => p >= b.min)?.label ?? 'Very unlikely';
}

export interface TierOdds {
  tier: number;
  applicants: number;
  children: number;
  /** null when suppressed for privacy (fewer than MIN_PUBLISHABLE_GROUP children). */
  pAtLeastOne: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  band: string | null;
  /** e.g. "Likely to very likely" when the 95% interval spans two bands. */
  bandRange: string | null;
}

export interface SessionDemand {
  week: string;
  ageGroup: string;
  capacity: number;
  firstChoice: number;
  totalRanked: number;
  /** totalRanked / capacity; null when capacity is 0. */
  demandPerSeat: number | null;
}

export interface OddsResult {
  modelVersion: string;
  iterations: number;
  seed: string;
  applicants: number;
  children: number;
  seats: number;
  tiers: TierOdds[];
  sessions: SessionDemand[];
}

/** Puts applicants in a canonical order so input order (and anything correlated with it, like submission time) cannot matter. */
export function canonicalise(input: OddsInput): OddsInput {
  return { ...input, applicants: [...input.applicants].sort((a, b) => (a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0)) };
}

export function estimateOdds(raw: OddsInput, opts: { iterations: number; seed: string }): OddsResult {
  const input = canonicalise(raw);
  const rng = mulberry32(hashSeed(opts.seed));
  const tiers = [...new Set(input.applicants.map((a) => a.tier))].sort((a, b) => a - b);
  const perTierFractions = new Map<number, number[]>(tiers.map((t) => [t, []]));
  const childCount = (t: number) => input.applicants.filter((a) => a.tier === t).reduce((n, a) => n + a.children.length, 0);

  for (let it = 0; it < opts.iterations; it++) {
    const result = simulateOnce(input, rng);
    for (const t of tiers) {
      let hits = 0;
      input.applicants.forEach((a, ai) => {
        if (a.tier !== t) return;
        a.children.forEach((_, ci) => {
          if ((result[ai]?.[ci]?.length ?? 0) > 0) hits++;
        });
      });
      const n = childCount(t);
      perTierFractions.get(t)?.push(n === 0 ? 0 : hits / n);
    }
  }

  const tierOdds: TierOdds[] = tiers.map((t) => {
    const children = childCount(t);
    const applicants = input.applicants.filter((a) => a.tier === t).length;
    if (children < MIN_PUBLISHABLE_GROUP) return { tier: t, applicants, children, pAtLeastOne: null, ciLow: null, ciHigh: null, band: null, bandRange: null };
    const xs = perTierFractions.get(t) ?? [];
    const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1);
    const se = Math.sqrt(variance / Math.max(1, xs.length));
    const lo = Math.max(0, mean - 1.96 * se);
    const hi = Math.min(1, mean + 1.96 * se);
    const band = bandOf(mean);
    const lowBand = bandOf(lo);
    const highBand = bandOf(hi);
    return {
      tier: t,
      applicants,
      children,
      pAtLeastOne: round3(mean),
      ciLow: round3(lo),
      ciHigh: round3(hi),
      band,
      bandRange: lowBand === highBand ? null : `${lowBand} to ${highBand.toLowerCase()}`,
    };
  });

  const sessions: SessionDemand[] = input.seats.map((s) => {
    let firstChoice = 0;
    let totalRanked = 0;
    for (const a of input.applicants) {
      for (const c of a.children) {
        const idx = c.rankedWeeks.indexOf(s.week);
        if (idx >= 0 && c.ageGroups[idx] === s.ageGroup) {
          totalRanked++;
          if (idx === 0) firstChoice++;
        }
      }
    }
    return { week: s.week, ageGroup: s.ageGroup, capacity: s.capacity, firstChoice, totalRanked, demandPerSeat: s.capacity > 0 ? round3(totalRanked / s.capacity) : null };
  });

  return {
    modelVersion: ODDS_MODEL_VERSION,
    iterations: opts.iterations,
    seed: opts.seed,
    applicants: input.applicants.length,
    children: input.applicants.reduce((n, a) => n + a.children.length, 0),
    seats: input.seats.reduce((n, s) => n + s.capacity, 0),
    tiers: tierOdds,
    sessions,
  };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function oddsAssumptions(iterations: number): string[] {
  return [
    'Based only on applications submitted so far; more applications usually lower the odds.',
    `Simulated ${String(iterations)} times with the published draw rules (model ${ODDS_MODEL_VERSION}); the real draw uses a public random number announced in advance.`,
    'Tiers use claimed home locations; organisers verify tiers before offers, which can move a family to a different tier.',
    'Declined offers and the waitlist can improve real outcomes; they are not included here.',
    `Tiers with fewer than ${String(MIN_PUBLISHABLE_GROUP)} children are not shown, to protect privacy.`,
  ];
}
