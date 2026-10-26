import { sha256Bytes, utf8 } from './draw/sha256.ts';

/**
 * Fairness report card (brief H4, Task 13), specified in docs/FAIRNESS.md.
 * Pure and deterministic: the public page (src/features/fairness) feeds it
 * the published, pseudonymous artifacts it has just re-hashed; the organiser
 * console (functions/shared/console.ts) feeds it committed rows; unit tests
 * feed it fixtures. It reports what the data says; it never decides anything.
 *
 * - Invariants: oversold seats, duplicate (child, week) placements, children
 *   given more weeks than requested, placements the inputs cannot explain,
 *   and splits of "together only" siblings. All must be 0.
 * - Placement rate (families with at least one week from the draw) by family
 *   size, tier and application-time quartile, with sample sizes and 95%
 *   Wilson intervals.
 * - First come, first served on the SAME applications and seats, with the
 *   same priority and sibling rules: only the lottery order is replaced by
 *   submission order (and families book all their weeks at once).
 * - Stratified permutation tests: within each priority group (override,
 *   tier, late), is getting a week associated with application time, or
 *   with family size? The same test on the first-come baseline shows what a
 *   real head start looks like to it.
 * - Offer and waitlist outcomes when they are supplied.
 *
 * Group differences alone never establish discrimination or fairness; the
 * report says so next to every number (docs/FAIRNESS.md).
 */

export const FAIRNESS_VERSION = 'even-odds-fairness-v1';

export interface FairnessChild {
  ref: string;
  rankedWeeks: string[];
  ageGroups: string[];
  requested: number;
}

export interface FairnessFamily {
  publicId: string;
  tier: number;
  siblingMode: 'together_only' | 'together_preferred' | 'independent';
  /** Approved pre-freeze override (draws ahead of every tier). */
  override?: boolean;
  /** Submitted after close under an accept-late policy (draws after on-time families of the tier). */
  late?: boolean;
  withdrawn?: boolean;
  /** Only used when no applicationOrder is given (the organiser console). */
  submittedAt?: string | null;
  children: FairnessChild[];
}

export interface FairnessPlacement {
  publicId: string;
  childRef: string;
  week: string;
  ageGroup: string;
}

export interface FairnessSession {
  week: string;
  ageGroup: string;
  capacity: number;
  /** Seats held now (seat_ledger / offer_stats), when known. */
  taken?: number;
}

export type OfferStatus = 'offered' | 'accepted' | 'declined' | 'expired' | 'released' | 'cancelled';
export type WaitlistStatus = 'waiting' | 'promoted' | 'removed';

export interface OfferOutcome {
  publicId: string;
  childRef: string;
  week: string;
  ageGroup: string;
  source: 'draw' | 'waitlist';
  status: OfferStatus;
}

export interface WaitlistOutcome {
  publicId: string;
  childRef: string;
  week: string;
  ageGroup: string;
  position: number;
  status: WaitlistStatus;
}

export interface FairnessInput {
  families: readonly FairnessFamily[];
  /** Placements the draw committed (not later waitlist offers). */
  placements: readonly FairnessPlacement[];
  /** Capacity the draw ran with (the frozen snapshot); `taken` = seats held now, if known. */
  sessions: readonly FairnessSession[];
  /** Public IDs in submission order (earliest first). Without it, `submittedAt` orders the families. */
  applicationOrder?: readonly string[];
  /** Capacity and seats held now, if they differ from `sessions` (offer_stats). */
  currentSessions?: readonly FairnessSession[];
  outcomes?: { entries: readonly OfferOutcome[]; waitlist: readonly WaitlistOutcome[] } | null;
  /** Snake rounds of the draw; caps weeks per child as the draw does. */
  maxWeeks?: number;
  /** Permutations per test (default 4000). */
  permutations?: number;
  /** Seeds the permutation generator; pass the inputs hash so anyone recomputes the same p-values. */
  testSeed?: string;
}

export interface RateRow {
  group: string;
  families: number;
  placed: number;
  /** placed / families, 0 when there are no families. */
  rate: number;
  /** 95% Wilson score interval for the rate. */
  low: number;
  high: number;
  children: number;
  childrenPlaced: number;
}

export interface BiasTest {
  key: 'application_time' | 'family_size' | 'first_come_application_time';
  question: string;
  status: 'tested' | 'not_meaningful';
  /** Why the test could not say anything (too few families, no variation within any priority group). */
  reason: string | null;
  families: number;
  /** Families in priority groups that had both outcomes and more than one group present. */
  informativeFamilies: number;
  strata: number;
  informativeStrata: number;
  groups: number;
  /** Pearson chi-square of (got a week × group), pooled. */
  statistic: number;
  /** Cramér's V of the pooled table (0 = no association, 1 = outcome fully determined by group). */
  effectSize: number;
  permutations: number;
  /** Monte Carlo p-value: (1 + permutations at least as extreme) / (1 + permutations). */
  pValue: number | null;
  conclusion: string;
}

export interface OversoldSession {
  week: string;
  ageGroup: string;
  capacity: number;
  taken: number;
}

export interface FairnessReport {
  version: typeof FAIRNESS_VERSION;
  families: number;
  children: number;
  seats: number;
  drawPlacements: number;
  familiesWithAWeek: number;
  childrenWithAWeek: number;
  /** Children who got every week they asked for. */
  childrenFullyServed: number;
  unusedSeats: number;
  invariants: {
    /** Sessions over capacity: by the draw's placements, or by seats held now. */
    oversoldSessions: OversoldSession[];
    /** Seats beyond capacity, summed over oversold sessions. */
    oversoldSeats: number;
    duplicatePlacements: number;
    /** Children given more weeks than they requested. */
    overRequested: number;
    /** Placements the inputs cannot explain: unknown child, week not ranked, wrong age group or unknown session. */
    unexplainedPlacements: number;
    /** "Together only" families with a week where a sibling who still wanted weeks was left out. */
    siblingSplits: number;
    togetherOnlyFamilies: number;
  };
  bySize: RateRow[];
  byTier: RateRow[];
  byApplicationTime: RateRow[];
  applicationOrder: {
    /** "none": no order is known, so time groups and the first-come baseline are not computed. */
    source: 'published_order' | 'submission_times' | 'none';
    /** Families with no place in the order (shown as "Unknown"). */
    missing: number;
    /** Order entries that are not applications in the inputs at all. */
    extra: number;
  };
  /** Null when no application order is known. */
  firstCome: {
    placements: number;
    familiesWithAWeek: number;
    childrenWithAWeek: number;
    siblingSplits: number;
    bySize: RateRow[];
    byTier: RateRow[];
    byApplicationTime: RateRow[];
    /** Kept for the console: families placed. */
    placed: number;
  } | null;
  tests: BiasTest[];
  outcomes: OutcomeReport | null;
}

export interface OutcomeReport {
  offers: { source: 'draw' | 'waitlist'; total: number; byStatus: Record<OfferStatus, number> }[];
  /** Seats held now by pending or accepted offers. */
  seatsHeld: number;
  /** Offers answered (accepted, declined) and lapsed (expired). */
  answered: number;
  accepted: number;
  waitlist: { total: number; children: number; byStatus: Record<WaitlistStatus, number> };
  /** Families holding at least one accepted offer now, by application time. */
  acceptedByApplicationTime: RateRow[];
}

// ---- small helpers ---------------------------------------------------------------

const key = (week: string, ageGroup: string) => `${week}\u0000${ageGroup}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const QUARTILE_ORDER = ['1st quarter (earliest)', '2nd quarter', '3rd quarter', '4th quarter (latest)', 'Unknown'];
export const SIZE_ORDER = ['1 child', '2 children', '3+ children'];
export const sizeLabel = (f: FairnessFamily) => (f.children.length >= 3 ? '3+ children' : f.children.length === 2 ? '2 children' : '1 child');
const tierLabel = (f: FairnessFamily) => `Tier ${String(f.tier)}`;

/** 95% Wilson score interval: honest at small n, unlike rate ± 1.96·SE. */
export function wilson(successes: number, n: number, z = 1.959964): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function rates(families: readonly FairnessFamily[], placed: ReadonlySet<string>, childPlaced: ReadonlySet<string>, groupOf: (f: FairnessFamily) => string, order?: readonly string[]): RateRow[] {
  const groups = new Map<string, { families: number; placed: number; children: number; childrenPlaced: number }>();
  for (const f of families) {
    const g = groupOf(f);
    const row = groups.get(g) ?? { families: 0, placed: 0, children: 0, childrenPlaced: 0 };
    row.families++;
    if (placed.has(f.publicId)) row.placed++;
    row.children += f.children.length;
    row.childrenPlaced += f.children.filter((c) => childPlaced.has(c.ref)).length;
    groups.set(g, row);
  }
  const known = order ? order.filter((g) => groups.has(g)) : [];
  const rest = [...groups.keys()].filter((g) => !known.includes(g)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return [...known, ...rest].map((g) => {
    const r = groups.get(g) ?? { families: 0, placed: 0, children: 0, childrenPlaced: 0 };
    return { group: g, ...r, rate: r.families ? r.placed / r.families : 0, ...wilson(r.placed, r.families) };
  });
}

/** Submission order from timestamps (console): ties and missing times by public ID, so it is deterministic. */
function orderFromTimes(families: readonly FairnessFamily[]): string[] {
  return [...families].sort((a, b) => cmp(a.submittedAt ?? '￿', b.submittedAt ?? '￿') || cmp(a.publicId, b.publicId)).map((f) => f.publicId);
}

/**
 * Quartile label per family by position in the submission order. Families
 * missing from the order are "Unknown" (and reported), never guessed.
 */
export function submissionQuartiles(families: readonly FairnessFamily[], applicationOrder?: readonly string[]): Map<string, string> {
  const inDraw = new Set(families.map((f) => f.publicId));
  const ordered = (applicationOrder ?? orderFromTimes(families)).filter((id) => inDraw.has(id));
  const unique = [...new Set(ordered)];
  const out = new Map<string, string>();
  unique.forEach((id, i) => out.set(id, QUARTILE_ORDER[Math.min(3, Math.floor((i * 4) / Math.max(1, unique.length)))] ?? ''));
  for (const f of families) if (!out.has(f.publicId)) out.set(f.publicId, 'Unknown');
  return out;
}

// ---- allocation checks -------------------------------------------------------------

/**
 * "Together only" splits: a week where some of the family's children are
 * placed while a sibling who never got all the weeks they asked for is not.
 * (Once a sibling's request is met, the others legitimately continue as the
 * group, docs/DRAW-ALGORITHM.md.)
 */
function countSiblingSplits(families: readonly FairnessFamily[], placements: readonly FairnessPlacement[], maxWeeks: number): { splits: number; togetherOnly: number } {
  const weeksOf = new Map<string, Set<string>>();
  for (const p of placements) weeksOf.set(p.childRef, (weeksOf.get(p.childRef) ?? new Set()).add(p.week));
  const together = families.filter((f) => !f.withdrawn && f.siblingMode === 'together_only' && f.children.length > 1);
  let splits = 0;
  for (const f of together) {
    const weeks = new Set(f.children.flatMap((c) => [...(weeksOf.get(c.ref) ?? [])]));
    const split = [...weeks].some((w) =>
      f.children.some((c) => {
        const held = weeksOf.get(c.ref) ?? new Set<string>();
        return !held.has(w) && held.size < Math.min(c.requested, maxWeeks);
      }),
    );
    if (split) splits++;
  }
  return { splits, togetherOnly: together.length };
}

function invariants(input: FairnessInput, maxWeeks: number) {
  const { families, placements, sessions } = input;
  const capacity = new Map(sessions.map((s) => [key(s.week, s.ageGroup), s.capacity]));
  const children = new Map(families.flatMap((f) => f.children.map((c) => [c.ref, { family: f, child: c }] as const)));

  const perSession = new Map<string, number>();
  const perChildWeek = new Map<string, number>();
  const perChild = new Map<string, Set<string>>();
  let unexplained = 0;
  for (const p of placements) {
    perSession.set(key(p.week, p.ageGroup), (perSession.get(key(p.week, p.ageGroup)) ?? 0) + 1);
    perChildWeek.set(`${p.childRef}\u0000${p.week}`, (perChildWeek.get(`${p.childRef}\u0000${p.week}`) ?? 0) + 1);
    perChild.set(p.childRef, (perChild.get(p.childRef) ?? new Set()).add(p.week));
    const known = children.get(p.childRef);
    const i = known ? known.child.rankedWeeks.indexOf(p.week) : -1;
    if (!known || known.family.publicId !== p.publicId || known.family.withdrawn || i < 0 || known.child.ageGroups[i] !== p.ageGroup || !capacity.has(key(p.week, p.ageGroup))) unexplained++;
  }

  // Oversold by the draw (frozen capacity), and by the seats held now (ledger / offer_stats) where known.
  const oversold = new Map<string, OversoldSession>();
  for (const s of sessions) {
    const n = perSession.get(key(s.week, s.ageGroup)) ?? 0;
    if (n > s.capacity) oversold.set(key(s.week, s.ageGroup), { week: s.week, ageGroup: s.ageGroup, capacity: s.capacity, taken: n });
  }
  for (const s of [...(input.currentSessions ?? []), ...sessions]) {
    if (s.taken === undefined || s.taken <= s.capacity) continue;
    const k = key(s.week, s.ageGroup);
    const prev = oversold.get(k);
    if (!prev || s.taken - s.capacity > prev.taken - prev.capacity) oversold.set(k, { week: s.week, ageGroup: s.ageGroup, capacity: s.capacity, taken: s.taken });
  }
  const oversoldSessions = [...oversold.values()].sort((a, b) => cmp(key(a.week, a.ageGroup), key(b.week, b.ageGroup)));
  const { splits, togetherOnly } = countSiblingSplits(families, placements, maxWeeks);
  return {
    oversoldSessions,
    oversoldSeats: oversoldSessions.reduce((n, s) => n + s.taken - s.capacity, 0),
    duplicatePlacements: [...perChildWeek.values()].filter((n) => n > 1).length,
    overRequested: [...perChild].filter(([ref, weeks]) => weeks.size > Math.min(children.get(ref)?.child.requested ?? Infinity, maxWeeks)).length,
    unexplainedPlacements: unexplained,
    siblingSplits: splits,
    togetherOnlyFamilies: togetherOnly,
  };
}

// ---- first come, first served ---------------------------------------------------------

/**
 * First-come counterfactual on the same applications and seats. The draw's
 * own rules apply (priority class, tier, on-time before late, sibling modes,
 * preference order, one week per child per session, requested weeks capped
 * at maxWeeks); two things change: within a priority group, families are
 * served in submission order instead of lottery order, and each family books
 * all its weeks before the next family starts (no snake), as on a first-come
 * booking portal. Mirrors the placement rules of shared/draw/plan.ts.
 */
export function firstComeAllocation(families: readonly FairnessFamily[], sessions: readonly FairnessSession[], opts: { applicationOrder?: readonly string[]; maxWeeks?: number } = {}): FairnessPlacement[] {
  const maxWeeks = opts.maxWeeks ?? 12;
  const left = new Map(sessions.map((s) => [key(s.week, s.ageGroup), s.capacity]));
  const position = new Map((opts.applicationOrder ?? orderFromTimes(families)).map((id, i) => [id, i]));
  const queue = families
    .filter((f) => !f.withdrawn)
    .sort((a, b) => Number(!a.override) - Number(!b.override) || a.tier - b.tier || Number(!!a.late) - Number(!!b.late) || (position.get(a.publicId) ?? Infinity) - (position.get(b.publicId) ?? Infinity) || cmp(a.publicId, b.publicId));
  const out: FairnessPlacement[] = [];

  for (const f of queue) {
    const kids = f.children.map((c) => {
      const keep = c.rankedWeeks.map((w, i) => ({ w, g: c.ageGroups[i] ?? '' })).filter(({ w, g }) => left.has(key(w, g)));
      return { ref: c.ref, rankedWeeks: keep.map((k) => k.w), ageGroups: keep.map((k) => k.g), requested: Math.max(0, Math.min(c.requested, maxWeeks)), held: new Set<string>() };
    });
    type Kid = (typeof kids)[number];
    const groupFor = (c: Kid, w: string) => c.ageGroups[c.rankedWeeks.indexOf(w)] ?? '';
    const place = (c: Kid, w: string) => {
      const g = groupFor(c, w);
      left.set(key(w, g), (left.get(key(w, g)) ?? 0) - 1);
      c.held.add(w);
      out.push({ publicId: f.publicId, childRef: c.ref, week: w, ageGroup: g });
    };
    const placeChild = (c: Kid) => {
      const w = c.rankedWeeks.find((week) => !c.held.has(week) && (left.get(key(week, groupFor(c, week))) ?? 0) > 0);
      if (w === undefined) return false;
      place(c, w);
      return true;
    };
    const placeTogether = (active: Kid[]) => {
      const first = active[0];
      if (!first) return false;
      const candidates = first.rankedWeeks
        .map((w, idx) => ({ w, idx, score: active.reduce((n, k) => n + k.rankedWeeks.indexOf(w), 0) }))
        .filter(({ w }) => active.every((k) => k.rankedWeeks.includes(w) && !k.held.has(w)))
        .sort((x, y) => x.score - y.score || x.idx - y.idx);
      for (const { w } of candidates) {
        const need = new Map<string, number>();
        for (const k of active) need.set(groupFor(k, w), (need.get(groupFor(k, w)) ?? 0) + 1);
        if ([...need].every(([g, n]) => (left.get(key(w, g)) ?? 0) >= n)) {
          for (const k of active) place(k, w);
          return true;
        }
      }
      return false;
    };
    for (let turn = 0; turn < maxWeeks; turn++) {
      const active = kids.filter((c) => c.held.size < c.requested);
      if (active.length === 0) break;
      let progress = false;
      if (active.length === 1 || f.siblingMode === 'independent') {
        for (const c of active) progress = placeChild(c) || progress;
      } else if (placeTogether(active)) {
        progress = true;
      } else if (f.siblingMode === 'together_preferred') {
        for (const c of active) progress = placeChild(c) || progress;
      }
      if (!progress) break;
    }
  }
  return out;
}

// ---- stratified permutation test ------------------------------------------------------

/** xoshiro128** seeded from SHA-256 of the seed string: deterministic in every engine. */
function generator(seed: string): () => number {
  const b = sha256Bytes(utf8(`${FAIRNESS_VERSION}\n${seed}`));
  const word = (i: number) => ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0;
  let s0 = word(0) || 1;
  let s1 = word(4);
  let s2 = word(8);
  let s3 = word(12);
  const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
  return () => {
    const result = (rotl(Math.imul(s1, 5) >>> 0, 7) * 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result / 4294967296;
  };
}

function chiSquare(outcome: readonly boolean[], group: readonly number[], groups: number): number {
  const placed = new Array<number>(groups).fill(0);
  const total = new Array<number>(groups).fill(0);
  let allPlaced = 0;
  for (let i = 0; i < outcome.length; i++) {
    const g = group[i] ?? 0;
    total[g] = (total[g] ?? 0) + 1;
    if (outcome[i]) {
      placed[g] = (placed[g] ?? 0) + 1;
      allPlaced++;
    }
  }
  const n = outcome.length;
  const p = n ? allPlaced / n : 0;
  let stat = 0;
  for (let g = 0; g < groups; g++) {
    const t = total[g] ?? 0;
    if (t === 0 || p === 0 || p === 1) continue;
    const e1 = t * p;
    const e0 = t * (1 - p);
    stat += ((placed[g] ?? 0) - e1) ** 2 / e1 + (t - (placed[g] ?? 0) - e0) ** 2 / e0;
  }
  return stat;
}

const fmtP = (p: number) => (p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`);

/**
 * Is "got a week" associated with the group, beyond what the priority rules
 * explain? Families are only compared within their own priority group
 * (override, tier, late): outcomes are shuffled among families of the same
 * group, so policy differences between tiers can never look like bias.
 */
export function stratifiedPermutationTest(opts: {
  key: BiasTest['key'];
  question: string;
  families: readonly FairnessFamily[];
  placed: ReadonlySet<string>;
  groupOf: (f: FairnessFamily) => string;
  permutations: number;
  seed: string;
  expectedNote?: string;
}): BiasTest {
  const fams = opts.families.filter((f) => !f.withdrawn);
  const labels = [...new Set(fams.map(opts.groupOf))].sort();
  const groupIndex = new Map(labels.map((l, i) => [l, i]));
  const strata = new Map<string, FairnessFamily[]>();
  for (const f of fams) {
    const s = `${f.override ? 0 : 1}|${String(f.tier)}|${f.late ? 1 : 0}`;
    strata.set(s, [...(strata.get(s) ?? []), f]);
  }
  // Only groups with both outcomes and more than one comparison group carry information.
  const informative = [...strata.values()].filter((members) => {
    const got = members.filter((f) => opts.placed.has(f.publicId)).length;
    return got > 0 && got < members.length && new Set(members.map(opts.groupOf)).size > 1;
  });
  const units = informative.flat();
  const base: Omit<BiasTest, 'status' | 'reason' | 'pValue' | 'conclusion'> = {
    key: opts.key,
    question: opts.question,
    families: fams.length,
    informativeFamilies: units.length,
    strata: strata.size,
    informativeStrata: informative.length,
    groups: labels.length,
    statistic: 0,
    effectSize: 0,
    permutations: 0,
  };
  const notMeaningful = (reason: string): BiasTest => ({ ...base, status: 'not_meaningful', reason, pValue: null, conclusion: `Not tested: ${reason}` });
  if (labels.length < 2) return notMeaningful('every family falls in the same group, so there is nothing to compare.');
  if (units.length < 8) {
    return notMeaningful(
      units.length === 0
        ? 'within every priority group, either every family got a week or none did (or all were in one group), so the outcome cannot depend on the group.'
        : `only ${String(units.length)} families are in priority groups where outcomes differ; at least 8 are needed for the test to mean anything.`,
    );
  }

  const outcome = units.map((f) => opts.placed.has(f.publicId));
  const group = units.map((f) => groupIndex.get(opts.groupOf(f)) ?? 0);
  const observed = chiSquare(outcome, group, labels.length);
  const ranges: [number, number][] = [];
  let start = 0;
  for (const members of informative) {
    ranges.push([start, start + members.length]);
    start += members.length;
  }
  const rand = generator(`${opts.seed}\n${opts.key}`);
  const shuffled = [...outcome];
  let extreme = 0;
  for (let n = 0; n < opts.permutations; n++) {
    for (const [lo, hi] of ranges) {
      for (let i = hi - 1; i > lo; i--) {
        const j = lo + Math.floor(rand() * (i - lo + 1));
        const t = shuffled[i] ?? false;
        shuffled[i] = shuffled[j] ?? false;
        shuffled[j] = t;
      }
    }
    if (chiSquare(shuffled, group, labels.length) >= observed - 1e-9) extreme++;
  }
  const pValue = (1 + extreme) / (1 + opts.permutations);
  const effectSize = Math.sqrt(observed / units.length);
  const note = opts.expectedNote ? ` ${opts.expectedNote}` : '';
  const conclusion =
    pValue < 0.05
      ? `Evidence of an association (${fmtP(pValue)}, Cramér's V = ${effectSize.toFixed(2)}, ${String(units.length)} families in ${String(informative.length)} comparable priority groups). By chance alone this happens about 1 time in 20 even when nothing is wrong; look at the groups and the inputs before concluding anything.${note}`
      : `No evidence of an association at this sample size (${fmtP(pValue)}, Cramér's V = ${effectSize.toFixed(2)}, ${String(units.length)} families in ${String(informative.length)} comparable priority groups). This does not show the draw is fair: small effects can go undetected, and the test cannot judge the tiers, overrides or inputs themselves.${note}`;
  return { ...base, status: 'tested', reason: null, statistic: observed, effectSize, permutations: opts.permutations, pValue, conclusion };
}

// ---- outcomes -------------------------------------------------------------------------

const OFFER_STATUSES: OfferStatus[] = ['offered', 'accepted', 'declined', 'expired', 'released', 'cancelled'];
const WAITLIST_STATUSES: WaitlistStatus[] = ['waiting', 'promoted', 'removed'];
const zeroes = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

function outcomeReport(outcomes: NonNullable<FairnessInput['outcomes']>, families: readonly FairnessFamily[], quartile: ReadonlyMap<string, string>): OutcomeReport {
  const offers = (['draw', 'waitlist'] as const).map((source) => {
    const mine = outcomes.entries.filter((e) => e.source === source);
    const byStatus = zeroes(OFFER_STATUSES);
    for (const e of mine) byStatus[e.status] += 1;
    return { source, total: mine.length, byStatus };
  });
  const byStatus = zeroes(WAITLIST_STATUSES);
  for (const w of outcomes.waitlist) byStatus[w.status] += 1;
  const sum = (s: OfferStatus) => offers.reduce((n, o) => n + o.byStatus[s], 0);
  const acceptedFamilies = new Set(outcomes.entries.filter((e) => e.status === 'accepted').map((e) => e.publicId));
  const acceptedChildren = new Set(outcomes.entries.filter((e) => e.status === 'accepted').map((e) => e.childRef));
  return {
    offers,
    seatsHeld: sum('offered') + sum('accepted'),
    answered: sum('accepted') + sum('declined') + sum('expired'),
    accepted: sum('accepted'),
    waitlist: { total: outcomes.waitlist.length, children: new Set(outcomes.waitlist.map((w) => w.childRef)).size, byStatus },
    acceptedByApplicationTime: rates(families.filter((f) => !f.withdrawn), acceptedFamilies, acceptedChildren, (f) => quartile.get(f.publicId) ?? 'Unknown', QUARTILE_ORDER),
  };
}

// ---- the report -----------------------------------------------------------------------

export function fairnessReport(input: FairnessInput): FairnessReport {
  const maxWeeks = input.maxWeeks ?? 12;
  const permutations = input.permutations ?? 4000;
  const seed = input.testSeed ?? 'fairness';
  const families = input.families.filter((f) => !f.withdrawn);
  const inDraw = new Set(families.map((f) => f.publicId));
  const placements = input.placements;

  const familiesPlaced = new Set(placements.map((p) => p.publicId));
  const childrenPlaced = new Set(placements.map((p) => p.childRef));
  const weeksPerChild = new Map<string, Set<string>>();
  for (const p of placements) weeksPerChild.set(p.childRef, (weeksPerChild.get(p.childRef) ?? new Set()).add(p.week));

  const order = input.applicationOrder ? [...input.applicationOrder] : undefined;
  const orderSource = order ? 'published_order' : families.some((f) => f.submittedAt) ? 'submission_times' : 'none';
  const quartile = orderSource === 'none' ? new Map<string, string>() : submissionQuartiles(families, order);
  const timeOf = (f: FairnessFamily) => quartile.get(f.publicId) ?? 'Unknown';
  const seats = input.sessions.reduce((n, s) => n + s.capacity, 0);

  const fc = orderSource === 'none' ? [] : firstComeAllocation(families, input.sessions, { applicationOrder: order, maxWeeks });
  const fcFamilies = new Set(fc.map((p) => p.publicId));
  const fcChildren = new Set(fc.map((p) => p.childRef));

  const time = (key: BiasTest['key'], placed: ReadonlySet<string>, question: string, expectedNote?: string) =>
    stratifiedPermutationTest({ key, question, families, placed, groupOf: timeOf, permutations, seed, expectedNote });

  return {
    version: FAIRNESS_VERSION,
    families: families.length,
    children: families.reduce((n, f) => n + f.children.length, 0),
    seats,
    drawPlacements: placements.length,
    familiesWithAWeek: [...familiesPlaced].filter((id) => inDraw.has(id)).length,
    childrenWithAWeek: childrenPlaced.size,
    childrenFullyServed: families.flatMap((f) => f.children).filter((c) => (weeksPerChild.get(c.ref)?.size ?? 0) >= Math.min(c.requested, maxWeeks)).length,
    unusedSeats: Math.max(0, seats - placements.length),
    invariants: invariants({ ...input, families }, maxWeeks),
    bySize: rates(families, familiesPlaced, childrenPlaced, sizeLabel, SIZE_ORDER),
    byTier: rates(families, familiesPlaced, childrenPlaced, tierLabel),
    byApplicationTime: rates(families, familiesPlaced, childrenPlaced, timeOf, QUARTILE_ORDER),
    applicationOrder: {
      source: orderSource,
      missing: families.filter((f) => timeOf(f) === 'Unknown').length,
      extra: order ? new Set(order.filter((id) => !input.families.some((f) => f.publicId === id))).size : 0,
    },
    firstCome: orderSource === 'none' ? null : {
      placements: fc.length,
      familiesWithAWeek: fcFamilies.size,
      childrenWithAWeek: fcChildren.size,
      siblingSplits: countSiblingSplits(families, fc, maxWeeks).splits,
      bySize: rates(families, fcFamilies, fcChildren, sizeLabel, SIZE_ORDER),
      byTier: rates(families, fcFamilies, fcChildren, tierLabel),
      byApplicationTime: rates(families, fcFamilies, fcChildren, timeOf, QUARTILE_ORDER),
      placed: fcFamilies.size,
    },
    tests: [
      time('application_time', familiesPlaced, 'Within each priority group, does applying earlier make getting a week more likely?'),
      stratifiedPermutationTest({
        key: 'family_size',
        question: 'Within each priority group, does family size change the chance of getting a week?',
        families,
        placed: familiesPlaced,
        groupOf: sizeLabel,
        permutations,
        seed,
        expectedNote: 'Some difference is expected from the rules themselves: "together only" siblings need several free seats in the same week at once, and every family, large or small, gets one turn per round.',
      }),
      ...(orderSource === 'none' ? [] : [time('first_come_application_time', fcFamilies, 'The same test on the first-come baseline: what a real head start looks like to it.', 'In the first-come baseline, application time decides the order by construction.')]),
    ],
    outcomes: input.outcomes ? outcomeReport(input.outcomes, families, quartile) : null,
  };
}

// ---- adapters ------------------------------------------------------------------------

/** Families from frozen draw inputs (shared/draw): tier, late, override and sibling mode as the draw saw them. */
export function familiesFromInputs(inputs: {
  applications: readonly { publicId: string; tier: number; late: boolean; siblingMode: FairnessFamily['siblingMode']; withdrawn?: boolean; children: readonly FairnessChild[] }[];
  overrides: readonly { publicId: string }[];
}): FairnessFamily[] {
  const overridden = new Set(inputs.overrides.map((o) => o.publicId));
  return inputs.applications.map((a) => ({
    publicId: a.publicId,
    tier: a.tier,
    late: a.late,
    siblingMode: a.siblingMode,
    override: overridden.has(a.publicId),
    ...(a.withdrawn ? { withdrawn: true } : {}),
    children: a.children.map((c) => ({ ref: c.ref, rankedWeeks: [...c.rankedWeeks], ageGroups: [...c.ageGroups], requested: c.requested })),
  }));
}
