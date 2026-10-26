import { concatBytes, fromHex, sha256Bytes, sha256Hex, toHex, utf8 } from './sha256.ts';

/**
 * THE Even Odds draw (algorithm `even-odds-draw-v1`). One pure, deterministic
 * module used by the server commit layer and the browser replay. It reads no
 * clock, network, database, environment or global state; identical inputs and
 * seed always give a byte-identical plan. Specified in docs/DRAW-ALGORITHM.md.
 */

export const DRAW_ALGORITHM = 'even-odds-draw-v1';
/**
 * Inputs format written by new freezes. v1 published each override's reason and pool next to
 * the receipt ID (e.g. "accommodation" = an aide, medical or access need). The draw never used
 * them (both pools rank the same), so v2 (Task 14) publishes only THAT a receipt has an
 * override. v1 inputs remain valid, so programs frozen earlier still verify.
 */
export const INPUTS_SCHEMA = 'draw-inputs-v2';
export const INPUTS_SCHEMAS: readonly string[] = ['draw-inputs-v1', INPUTS_SCHEMA];

export type SiblingMode = 'together_only' | 'together_preferred' | 'independent';

export interface DrawSession {
  week: string;
  ageGroup: string;
  capacity: number;
}

export interface DrawChild {
  /** Pseudonymous child reference (the ticket ID); never a name or birthdate. */
  ref: string;
  rankedWeeks: string[];
  /** Age group per ranked week, fixed at submission from the child's age on the week's first day. */
  ageGroups: string[];
  requested: number;
}

export interface DrawApplication {
  publicId: string;
  /** Effective tier: verified tier if set, else claimed tier, else the program default. Lower draws first. */
  tier: number;
  late: boolean;
  siblingMode: SiblingMode;
  withdrawn?: boolean;
  children: DrawChild[];
}

export interface DrawOverride {
  publicId: string;
  /** draw-inputs-v1 only (not published from v2 on). */
  reasonCode?: string;
  /** draw-inputs-v1 only (not published from v2 on). */
  pool?: 'general' | 'accommodation';
}

export interface DrawInputs {
  /** Checked at run time: inputs may come from an untrusted published file. */
  schema: string;
  algorithm: string;
  programId: string;
  maxWeeks: number;
  sessions: DrawSession[];
  applications: DrawApplication[];
  overrides: DrawOverride[];
}

export interface OrderEntry {
  position: number;
  publicId: string;
  /** 0 = approved pre-freeze override, 1 = everyone else. Lower draws first. */
  priorityClass: number;
  tier: number;
  late: boolean;
  lotteryHash: string;
}

export interface Placement {
  childRef: string;
  week: string;
  ageGroup: string;
}

export interface PlanStep {
  index: number;
  round: number;
  publicId: string;
  /** "group": siblings placed together (one transaction). "child": a single child. */
  kind: 'group' | 'child';
  placements: Placement[];
}

export interface WaitlistEntry {
  week: string;
  ageGroup: string;
  position: number;
  publicId: string;
  childRef: string;
}

export interface DrawPlan {
  algorithm: typeof DRAW_ALGORITHM;
  inputsHash: string;
  seed: string;
  order: OrderEntry[];
  steps: PlanStep[];
  waitlist: WaitlistEntry[];
  warnings: string[];
  summary: { applications: number; children: number; placements: number; childrenWithAWeek: number; seats: number };
}

// ---- Canonical form and hashes ----------------------------------------------------

/** JSON with sorted object keys (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Canonical inputs: applications sorted by public ID, overrides by public ID,
 * sessions by (week, age group). Order of the source rows can never matter.
 */
export function canonicaliseInputs(inputs: DrawInputs): DrawInputs {
  const by = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return {
    ...inputs,
    sessions: [...inputs.sessions].sort(by((s) => `${s.week}\u0000${s.ageGroup}`)),
    applications: [...inputs.applications].sort(by((a) => a.publicId)),
    overrides: [...inputs.overrides].sort(by((o) => o.publicId)),
  };
}

/** The hash published at freeze, before the seed exists. */
export const inputsHash = (inputs: DrawInputs): string => sha256Hex(canonicalJson(canonicaliseInputs(inputs)));

export const planHash = (plan: DrawPlan): string => sha256Hex(canonicalJson({ ...plan, warnings: [] }));

/** SHA-256( seed bytes (hex-decoded) || UTF-8(public ID) ), lowercase hex. */
export function lotteryHash(seedHex: string, publicId: string): string {
  return toHex(sha256Bytes(concatBytes(fromHex(seedHex), utf8(publicId))));
}

// ---- Validation --------------------------------------------------------------------

export function validateInputs(inputs: DrawInputs): string[] {
  const problems: string[] = [];
  if (!INPUTS_SCHEMAS.includes(inputs.schema)) problems.push(`Unsupported inputs schema "${inputs.schema}"`);
  if (inputs.schema === INPUTS_SCHEMA && inputs.overrides.some((o) => o.reasonCode !== undefined || o.pool !== undefined)) {
    problems.push(`${INPUTS_SCHEMA} overrides carry only a public ID (no reason or pool)`);
  }
  if (inputs.algorithm !== DRAW_ALGORITHM) problems.push(`Inputs were frozen for algorithm "${inputs.algorithm}", this module implements "${DRAW_ALGORITHM}"`);
  if (!Number.isInteger(inputs.maxWeeks) || inputs.maxWeeks < 1) problems.push('maxWeeks must be a positive integer');
  const sessionKeys = new Set<string>();
  for (const s of inputs.sessions) {
    const k = `${s.week}\u0000${s.ageGroup}`;
    if (sessionKeys.has(k)) problems.push(`Duplicate session ${s.week}/${s.ageGroup}`);
    sessionKeys.add(k);
    if (!Number.isInteger(s.capacity) || s.capacity < 0) problems.push(`Invalid capacity for ${s.week}/${s.ageGroup}`);
  }
  const ids = new Set<string>();
  const refs = new Set<string>();
  for (const a of inputs.applications) {
    if (ids.has(a.publicId)) problems.push(`Duplicate application ${a.publicId}`);
    ids.add(a.publicId);
    for (const c of a.children) {
      if (refs.has(c.ref)) problems.push(`Child ${c.ref} appears in more than one application`);
      refs.add(c.ref);
      if (c.ageGroups.length !== c.rankedWeeks.length) problems.push(`Child ${c.ref}: ageGroups and rankedWeeks differ in length`);
    }
  }
  return problems;
}

// ---- The draw ----------------------------------------------------------------------

/**
 * Computes the full placement plan.
 *
 * Order (once, fixed by the seed): priority class (approved override first),
 * tier ascending, on-time before late, then lotteryHash ascending; public ID
 * breaks the (practically impossible) remaining ties.
 *
 * Rounds 1..maxWeeks, snake: odd rounds forward, even rounds reversed. In each
 * round, each family with children still wanting weeks gets one turn:
 *  - together_only: siblings still wanting weeks are placed together in the
 *    first common week (lowest summed rank; ties by the first child's ranking)
 *    with room for all of them, all-or-nothing (one step); otherwise nothing.
 *  - together_preferred: as together_only; if no such week, each child is then
 *    placed on their own (one step per child placed).
 *  - independent / single child: each child takes their highest-ranked week
 *    that has a free seat in their age group and that they do not already hold.
 * A full week is skipped and the next preference tried ("capacity conflicts
 * are resolved by trying the next eligible preference").
 *
 * Waitlist: for every session, children who ranked it, did not get it, and
 * still wanted more weeks when the draw ended, in lottery order.
 */
export function computePlan(rawInputs: DrawInputs, seedHex: string): DrawPlan {
  const problems = validateInputs(rawInputs);
  if (problems.length > 0) throw new Error(`Invalid draw inputs: ${problems.join('; ')}`);
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error('Seed must be 64 lowercase hex characters (32 bytes)');

  const inputs = canonicaliseInputs(rawInputs);
  const warnings: string[] = [];
  const sessionKey = (w: string, g: string) => `${w}\u0000${g}`;
  const remaining = new Map(inputs.sessions.map((s) => [sessionKey(s.week, s.ageGroup), s.capacity]));
  const overridden = new Set(inputs.overrides.map((o) => o.publicId));

  // Impossible preferences (unknown week/age-group pairs) are dropped, with a warning.
  const apps = inputs.applications
    .filter((a) => !a.withdrawn)
    .map((a) => ({
      ...a,
      children: a.children.map((c) => {
        const keep = c.rankedWeeks.map((w, i) => ({ w, g: c.ageGroups[i] ?? '' })).filter(({ w, g }) => {
          const ok = remaining.has(sessionKey(w, g));
          if (!ok) warnings.push(`Child ${c.ref}: no session ${w}/${g}; preference ignored`);
          return ok;
        });
        return { ...c, rankedWeeks: keep.map((k) => k.w), ageGroups: keep.map((k) => k.g), requested: Math.max(0, Math.min(c.requested, inputs.maxWeeks)) };
      }),
    }));

  const order: OrderEntry[] = apps
    .map((a) => ({ publicId: a.publicId, priorityClass: (overridden.has(a.publicId) ? 0 : 1), tier: a.tier, late: a.late, lotteryHash: lotteryHash(seedHex, a.publicId), position: 0 }))
    .sort((x, y) => x.priorityClass - y.priorityClass || x.tier - y.tier || Number(x.late) - Number(y.late) || (x.lotteryHash < y.lotteryHash ? -1 : x.lotteryHash > y.lotteryHash ? 1 : 0) || (x.publicId < y.publicId ? -1 : 1))
    .map((e, i) => ({ ...e, position: i + 1 }));
  const appById = new Map(apps.map((a) => [a.publicId, a]));
  const held = new Map<string, Set<string>>(apps.flatMap((a) => a.children.map((c) => [c.ref, new Set<string>()] as const)));
  const steps: PlanStep[] = [];

  const groupFor = (c: DrawChild, week: string) => c.ageGroups[c.rankedWeeks.indexOf(week)] ?? '';
  const wants = (c: DrawChild) => (held.get(c.ref)?.size ?? 0) < c.requested;
  const addStep = (round: number, publicId: string, kind: PlanStep['kind'], placements: Placement[]) => {
    steps.push({ index: steps.length, round, publicId, kind, placements });
  };

  const placeChild = (round: number, publicId: string, c: DrawChild) => {
    const mine = held.get(c.ref);
    if (!mine) return;
    for (const week of c.rankedWeeks) {
      const g = groupFor(c, week);
      const k = sessionKey(week, g);
      if (!mine.has(week) && (remaining.get(k) ?? 0) > 0) {
        remaining.set(k, (remaining.get(k) ?? 0) - 1);
        mine.add(week);
        addStep(round, publicId, 'child', [{ childRef: c.ref, week, ageGroup: g }]);
        return;
      }
    }
  };

  const placeTogether = (round: number, publicId: string, kids: DrawChild[]): boolean => {
    const first = kids[0];
    if (!first) return false;
    const candidates = first.rankedWeeks
      .map((w, idx) => ({ w, idx, score: kids.reduce((n, k) => n + k.rankedWeeks.indexOf(w), 0) }))
      .filter(({ w }) => kids.every((k) => k.rankedWeeks.includes(w) && !held.get(k.ref)?.has(w)))
      .sort((x, y) => x.score - y.score || x.idx - y.idx);
    for (const { w } of candidates) {
      const need = new Map<string, number>();
      for (const k of kids) need.set(groupFor(k, w), (need.get(groupFor(k, w)) ?? 0) + 1);
      if ([...need].every(([g, n]) => (remaining.get(sessionKey(w, g)) ?? 0) >= n)) {
        for (const [g, n] of need) remaining.set(sessionKey(w, g), (remaining.get(sessionKey(w, g)) ?? 0) - n);
        for (const k of kids) held.get(k.ref)?.add(w);
        addStep(round, publicId, 'group', kids.map((k) => ({ childRef: k.ref, week: w, ageGroup: groupFor(k, w) })));
        return true;
      }
    }
    return false;
  };

  for (let round = 1; round <= inputs.maxWeeks; round++) {
    const sequence = round % 2 === 1 ? order : [...order].reverse();
    for (const entry of sequence) {
      const app = appById.get(entry.publicId);
      if (!app) continue;
      const active = app.children.filter(wants);
      if (active.length === 0) continue;
      if (active.length === 1 || app.siblingMode === 'independent') {
        for (const c of active) placeChild(round, app.publicId, c);
      } else if (!placeTogether(round, app.publicId, active) && app.siblingMode === 'together_preferred') {
        for (const c of active) placeChild(round, app.publicId, c);
      }
    }
  }

  const waitlist: WaitlistEntry[] = [];
  const positions = new Map<string, number>();
  for (const entry of order) {
    const app = appById.get(entry.publicId);
    if (!app) continue;
    for (const c of app.children) {
      if (!wants(c)) continue;
      c.rankedWeeks.forEach((week, i) => {
        if (held.get(c.ref)?.has(week)) return;
        const g = c.ageGroups[i] ?? '';
        const k = sessionKey(week, g);
        const position = (positions.get(k) ?? 0) + 1;
        positions.set(k, position);
        waitlist.push({ week, ageGroup: g, position, publicId: app.publicId, childRef: c.ref });
      });
    }
  }

  const allChildren = apps.flatMap((a) => a.children);
  return {
    algorithm: DRAW_ALGORITHM,
    inputsHash: inputsHash(rawInputs),
    seed: seedHex,
    order,
    steps,
    waitlist,
    warnings,
    summary: {
      applications: apps.length,
      children: allChildren.length,
      placements: steps.reduce((n, s) => n + s.placements.length, 0),
      childrenWithAWeek: allChildren.filter((c) => (held.get(c.ref)?.size ?? 0) > 0).length,
      seats: inputs.sessions.reduce((n, s) => n + s.capacity, 0),
    },
  };
}
