// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, computePlan, inputsHash, lotteryHash, planHash, validateInputs, type DrawApplication, type DrawInputs, type DrawPlan } from '../../shared/draw/index.ts';
import { sha256Bytes, toHex, utf8 } from '../../shared/draw/sha256.ts';
import { mulberry32 } from '../../shared/odds.ts';
import { GOLDEN_INPUTS, GOLDEN_PLAN_HASH, GOLDEN_SEED } from '../fixtures/draw-golden.ts';

const SEED = 'a'.repeat(64);
const SEED2 = 'b'.repeat(64);
const base = (patch: Partial<DrawInputs>): DrawInputs => ({ schema: 'draw-inputs-v1', algorithm: 'even-odds-draw-v1', programId: 'p', maxWeeks: 1, sessions: [], applications: [], overrides: [], ...patch });
const app = (publicId: string, weeks: string[], opts: Partial<DrawApplication> = {}, requested = 1, group = 'g'): DrawApplication => ({
  publicId, tier: 1, late: false, siblingMode: 'independent', children: [{ ref: `${publicId}-c`, rankedWeeks: weeks, ageGroups: weeks.map(() => group), requested }], ...opts,
});
const placedWeeks = (plan: DrawPlan, ref: string) => plan.steps.flatMap((s) => s.placements).filter((p) => p.childRef === ref).map((p) => p.week);

describe('sha256', () => {
  it('matches node:crypto, including empty, multi-block and non-ASCII input', () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(1000), 'José Núñez 🎪']) {
      expect(toHex(sha256Bytes(utf8(s)))).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  it('lotteryHash is SHA-256(seed bytes || UTF-8 public ID)', () => {
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from(SEED, 'hex'), Buffer.from('fam1', 'utf8')])).digest('hex');
    expect(lotteryHash(SEED, 'fam1')).toBe(expected);
  });
});

describe('golden plan', () => {
  it('is byte-for-byte stable (change deliberately, with an algorithm version bump)', () => {
    const plan = computePlan(GOLDEN_INPUTS, GOLDEN_SEED);
    expect(planHash(plan)).toBe(GOLDEN_PLAN_HASH);
  });
});

describe('ordering', () => {
  it('sorts by override, then tier, then on-time before late, then lottery hash', () => {
    const plan = computePlan(base({ applications: [app('t2', ['W1'], { tier: 2 }), app('late', ['W1'], { tier: 0, late: true }), app('t0', ['W1'], { tier: 0 }), app('ov', ['W1'], { tier: 3 })], overrides: [{ publicId: 'ov', reasonCode: 'staff_family', pool: 'general' }], sessions: [{ week: 'W1', ageGroup: 'g', capacity: 1 }] }), SEED);
    expect(plan.order.map((o) => o.publicId)).toEqual(['ov', 't0', 'late', 't2']);
  });

  it('within a tier, order follows the hash and nothing else', () => {
    const apps = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => app(id, ['W1']));
    const plan = computePlan(base({ applications: apps, sessions: [{ week: 'W1', ageGroup: 'g', capacity: 2 }] }), SEED);
    const byHash = [...apps].map((a) => a.publicId).sort((a, b) => lotteryHash(SEED, a).localeCompare(lotteryHash(SEED, b)));
    expect(plan.order.map((o) => o.publicId)).toEqual(byHash);
    expect(plan.steps.map((s) => s.publicId)).toEqual(byHash.slice(0, 2));
  });

  it('is independent of input row order, and changes with the seed', () => {
    const inputs = base({ applications: ['x1', 'x2', 'x3', 'x4'].map((id) => app(id, ['W1'])), sessions: [{ week: 'W1', ageGroup: 'g', capacity: 2 }] });
    const reversed = { ...inputs, applications: [...inputs.applications].reverse(), sessions: [...inputs.sessions].reverse() };
    expect(canonicalJson(computePlan(reversed, SEED))).toBe(canonicalJson(computePlan(inputs, SEED)));
    expect(inputsHash(reversed)).toBe(inputsHash(inputs));
    expect(computePlan(inputs, SEED).order.map((o) => o.publicId)).not.toEqual(computePlan(inputs, SEED2).order.map((o) => o.publicId));
  });

  it('repeat execution gives identical plans', () => {
    expect(computePlan(GOLDEN_INPUTS, GOLDEN_SEED)).toEqual(computePlan(GOLDEN_INPUTS, GOLDEN_SEED));
  });
});

describe('placement rules', () => {
  const sessions = (spec: Record<string, number>, group = 'g') => Object.entries(spec).map(([week, capacity]) => ({ week, ageGroup: group, capacity }));

  it('full session: the next preference is tried; empty session: nobody is placed', () => {
    const plan = computePlan(base({ applications: [app('a', ['W1', 'W2']), app('b', ['W1', 'W2'])], sessions: sessions({ W1: 1, W2: 1 }) }), SEED);
    const [first, second] = plan.order.map((o) => o.publicId);
    expect(placedWeeks(plan, `${first ?? ''}-c`)).toEqual(['W1']);
    expect(placedWeeks(plan, `${second ?? ''}-c`)).toEqual(['W2']);
    const empty = computePlan(base({ applications: [app('a', ['W1'])], sessions: sessions({ W1: 0 }) }), SEED);
    expect(empty.steps).toEqual([]);
    expect(empty.waitlist).toEqual([{ week: 'W1', ageGroup: 'g', position: 1, publicId: 'a', childRef: 'a-c' }]);
  });

  it('age-group capacities are separate', () => {
    const plan = computePlan(base({ applications: [app('y', ['W1'], {}, 1, 'young'), app('o', ['W1'], {}, 1, 'old')], sessions: [{ week: 'W1', ageGroup: 'young', capacity: 1 }, { week: 'W1', ageGroup: 'old', capacity: 1 }] }), SEED);
    expect(plan.summary.placements).toBe(2);
  });

  it('snake draft: round 2 runs in reverse and everyone gets one week before anyone gets two', () => {
    const plan = computePlan(base({ maxWeeks: 2, applications: [app('a', ['W1', 'W2', 'W3'], {}, 2), app('b', ['W1', 'W2', 'W3'], {}, 2)], sessions: sessions({ W1: 1, W2: 1, W3: 1 }) }), SEED);
    const [first, second] = plan.order.map((o) => o.publicId);
    expect(plan.steps.map((s) => [s.round, s.publicId])).toEqual([[1, first], [1, second], [2, second]]);
  });

  it('together_only places siblings as one unit or not at all', () => {
    const fam: DrawApplication = { publicId: 'fam', tier: 1, late: false, siblingMode: 'together_only', children: [
      { ref: 'k1', rankedWeeks: ['W1'], ageGroups: ['young'], requested: 1 },
      { ref: 'k2', rankedWeeks: ['W1'], ageGroups: ['old'], requested: 1 },
    ] };
    const blocked = computePlan(base({ applications: [fam], sessions: [{ week: 'W1', ageGroup: 'young', capacity: 1 }, { week: 'W1', ageGroup: 'old', capacity: 0 }] }), SEED);
    expect(blocked.steps).toEqual([]);
    const ok = computePlan(base({ applications: [fam], sessions: [{ week: 'W1', ageGroup: 'young', capacity: 1 }, { week: 'W1', ageGroup: 'old', capacity: 1 }] }), SEED);
    expect(ok.steps).toEqual([{ index: 0, round: 1, publicId: 'fam', kind: 'group', placements: [{ childRef: 'k1', week: 'W1', ageGroup: 'young' }, { childRef: 'k2', week: 'W1', ageGroup: 'old' }] }]);
  });

  it('together_preferred falls back to separate placements; independent never waits for siblings', () => {
    const kids = [
      { ref: 'k1', rankedWeeks: ['W1', 'W2'], ageGroups: ['g', 'g'], requested: 1 },
      { ref: 'k2', rankedWeeks: ['W1', 'W2'], ageGroups: ['g', 'g'], requested: 1 },
    ];
    const s = sessions({ W1: 1, W2: 1 });
    const pref = computePlan(base({ applications: [{ publicId: 'f', tier: 1, late: false, siblingMode: 'together_preferred', children: kids }], sessions: s }), SEED);
    expect(pref.steps.map((x) => [x.kind, x.placements.map((p) => `${p.childRef}@${p.week}`)])).toEqual([['child', ['k1@W1']], ['child', ['k2@W2']]]);
    const only = computePlan(base({ applications: [{ publicId: 'f', tier: 1, late: false, siblingMode: 'together_only', children: kids }], sessions: s }), SEED);
    expect(only.steps).toEqual([]);
    const ind = computePlan(base({ applications: [{ publicId: 'f', tier: 1, late: false, siblingMode: 'independent', children: kids }], sessions: s }), SEED);
    expect(ind.summary.placements).toBe(2);
  });

  it('late applicants, withdrawals and impossible preferences', () => {
    const plan = computePlan(GOLDEN_INPUTS, GOLDEN_SEED);
    expect(plan.order.map((o) => o.publicId)).not.toContain('e5'); // withdrawn
    const ordered = plan.order.map((o) => o.publicId);
    expect(ordered.indexOf('d4')).toBeGreaterThan(ordered.indexOf('b2')); // late after on-time, same tier
    expect(ordered[0]).toBe('f6'); // approved override first despite tier 2
    expect(plan.warnings).toEqual(['Child f6-c1: no session W9/old; preference ignored']);
  });
});

describe('validation', () => {
  it('rejects malformed inputs and seeds instead of guessing', () => {
    expect(validateInputs(base({ applications: [app('a', ['W1']), app('a', ['W1'])] }))).toContain('Duplicate application a');
    expect(validateInputs({ ...base({}), algorithm: 'other' })[0]).toMatch(/algorithm/);
    expect(() => computePlan(base({}), 'not-hex')).toThrow(/Seed/);
  });
});

describe('generated instances (property test)', () => {
  it('never exceeds capacity, never double-books, respects requests and sibling atomicity', () => {
    for (let n = 0; n < 200; n++) {
      const rng = mulberry32(500 + n);
      const weeks = ['W1', 'W2', 'W3', 'W4'].slice(0, 1 + Math.floor(rng() * 4));
      const groups = ['g1', 'g2'];
      const sessions = weeks.flatMap((w) => groups.map((g) => ({ week: w, ageGroup: g, capacity: Math.floor(rng() * 4) })));
      const applications: DrawApplication[] = Array.from({ length: 1 + Math.floor(rng() * 15) }, (_, i) => ({
        publicId: `f${String(i)}`,
        tier: Math.floor(rng() * 3),
        late: rng() < 0.15,
        withdrawn: rng() < 0.05,
        siblingMode: (['together_only', 'together_preferred', 'independent'] as const)[Math.floor(rng() * 3)] ?? 'independent',
        children: Array.from({ length: 1 + Math.floor(rng() * 3) }, (_, k) => {
          const ranked = [...weeks].sort(() => rng() - 0.5).slice(0, 1 + Math.floor(rng() * weeks.length));
          const g = groups[Math.floor(rng() * 2)] ?? 'g1';
          return { ref: `f${String(i)}-${String(k)}`, rankedWeeks: ranked, ageGroups: ranked.map(() => g), requested: 1 + Math.floor(rng() * 3) };
        }),
      }));
      const inputs = base({ maxWeeks: 1 + Math.floor(rng() * 3), sessions, applications });
      const seed = toHex(sha256Bytes(utf8(`seed-${String(n)}`)));
      const plan = computePlan(inputs, seed);

      for (const s of sessions) {
        const used = plan.steps.flatMap((x) => x.placements).filter((p) => p.week === s.week && p.ageGroup === s.ageGroup).length;
        expect(used).toBeLessThanOrEqual(s.capacity);
      }
      for (const a of applications) {
        for (const c of a.children) {
          const ws = placedWeeks(plan, c.ref);
          expect(new Set(ws).size).toBe(ws.length);
          expect(ws.length).toBeLessThanOrEqual(Math.min(c.requested, inputs.maxWeeks));
          expect(ws.every((w) => c.rankedWeeks.includes(w))).toBe(true);
          if (a.withdrawn) expect(ws).toEqual([]);
        }
        if (a.siblingMode === 'together_only') {
          // At most one step per round, and every child placed in it attends the same week.
          for (let r = 1; r <= inputs.maxWeeks; r++) {
            const mine = plan.steps.filter((s) => s.publicId === a.publicId && s.round === r);
            expect(mine.length).toBeLessThanOrEqual(1);
            expect(new Set(mine.flatMap((s) => s.placements.map((p) => p.week))).size).toBeLessThanOrEqual(1);
          }
        }
      }
      expect(computePlan({ ...inputs, applications: [...applications].reverse() }, seed)).toEqual(plan);
    }
  });
});

describe('program status transitions', () => {
  it('only allows draft → open → frozen → drawn → closed', async () => {
    const { canTransition } = await import('../../functions/shared/program-status.ts');
    expect(canTransition('draft', 'open')).toBe(true);
    expect(canTransition('open', 'frozen')).toBe(true);
    expect(canTransition('frozen', 'drawn')).toBe(true);
    expect(canTransition('drawn', 'closed')).toBe(true);
    for (const [from, to] of [['draft', 'frozen'], ['open', 'drawn'], ['frozen', 'open'], ['drawn', 'open'], ['closed', 'open']] as const) {
      expect(canTransition(from, to)).toBe(false);
    }
  });
});
