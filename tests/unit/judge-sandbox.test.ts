/**
 * Task 12, pure parts: the demo timing profile, demo/production namespace
 * guards and the guarantees the seeded scenario
 * makes (each demonstration is guaranteed by the data, not by chance).
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../functions/shared/app-error.ts';
import { assertProduction, assertSandboxOf, assertScope } from '../../functions/shared/namespace.ts';
import { consoleCommandSchema, consoleRequestSchema } from '../../shared/console-input.ts';
import { DEMO_DUPLICATE_CHILD, DEMO_FAMILIES, DEMO_OVERSUBSCRIBED, DEMO_PROGRAM, DEMO_ROLLBACK_FAMILY, DEMO_SESSIONS } from '../../shared/demo-scenario.ts';
import { demoRequestSchema } from '../../shared/demo-input.ts';
import { weeksForChild } from '../../shared/eligibility.ts';
import { announcedRound, freezeDeadlineMs, roundTimeMs, TIMING, timingOf } from '../../shared/freeze/protocol.ts';
import { programDetailsSchema } from '../../shared/program-input.ts';

const sessionsRows = DEMO_SESSIONS.map((s) => ({ week: s.week, week_start: `${s.weekStart}T00:00:00.000Z`, age_group: s.ageGroup, min_age: s.minAge, max_age: s.maxAge, capacity: s.capacity, label: s.label }));

describe('demo timing profile', () => {
  it('is used only by demo programs', () => {
    expect(timingOf({ namespace: 'demo' })).toBe('demo');
    expect(timingOf({ namespace: null })).toBe('standard');
    expect(timingOf({ namespace: 'production' })).toBe('standard');
    expect(timingOf({})).toBe('standard');
  });

  it('announces a round that does not exist yet at the close, with time to freeze before it', () => {
    const close = '2026-10-25T06:00:00.000Z';
    const round = announcedRound(close, 'demo');
    expect(roundTimeMs(round)).toBeGreaterThanOrEqual(Date.parse(close) + TIMING.demo.roundDelayMs);
    expect(roundTimeMs(round) - Date.parse(close)).toBeLessThan(TIMING.demo.roundDelayMs + 3_001);
    expect(freezeDeadlineMs(round, 'demo')).toBeGreaterThan(Date.parse(close));
    // The production rule is unchanged.
    expect(announcedRound(close)).toBe(announcedRound(close, 'standard'));
    expect(roundTimeMs(announcedRound(close)) - Date.parse(close)).toBeGreaterThanOrEqual(3 * 3600_000);
  });
});

describe('demo / production separation guards', () => {
  const demo = { namespace: 'demo' as const, sandbox_owner: 'visitor-1', synthetic: true };
  const production = { namespace: null, sandbox_owner: null, synthetic: false };

  it('hides demo programs from production paths', () => {
    expect(() => { assertProduction(demo); }).toThrow(AppError);
    expect(() => { assertProduction(production); }).not.toThrow();
    expect(() => { assertScope(demo, 'production'); }).toThrow(AppError);
  });

  it('lets a demo path touch only the caller\'s own synthetic demo program', () => {
    expect(() => { assertSandboxOf(demo, 'visitor-1'); }).not.toThrow();
    expect(() => { assertSandboxOf(demo, 'visitor-2'); }).toThrow(AppError);
    expect(() => { assertSandboxOf(production, 'visitor-1'); }).toThrow(AppError);
    expect(() => { assertSandboxOf({ ...demo, synthetic: false }, 'visitor-1'); }).toThrow(AppError);
    expect(() => { assertScope(production, 'demo'); }).toThrow(AppError);
  });

  it('never accepts a program ID in a demo request', () => {
    expect(demoRequestSchema.parse({ action: 'status', programId: 'someone-else' })).toEqual({ action: 'status' });
    expect(demoRequestSchema.safeParse({ action: 'console', command: { action: 'demand' } }).success).toBe(true);
    expect(demoRequestSchema.safeParse({ action: 'deleteEverything' }).success).toBe(false);
  });

  it('requires reason codes (no free text) for privileged console changes', () => {
    const publicId = 'a'.repeat(32);
    const idempotencyKey = 'k'.repeat(20);
    expect(consoleCommandSchema.safeParse({ action: 'createOverride', publicId, reasonCode: 'accommodation', pool: 'general', idempotencyKey }).success).toBe(true);
    expect(consoleCommandSchema.safeParse({ action: 'createOverride', publicId, reasonCode: 'because I said so', pool: 'general', idempotencyKey }).success).toBe(false);
    expect(consoleCommandSchema.safeParse({ action: 'verifyTier', publicId, tier: 0, idempotencyKey }).success).toBe(false);
    expect(consoleRequestSchema.safeParse({ command: { action: 'demand' } }).success).toBe(false); // production needs a program
  });
});

describe('seeded judge scenario', () => {
  it('is a valid program with several weeks and age groups', () => {
    const now = Date.now();
    expect(programDetailsSchema.safeParse({ ...DEMO_PROGRAM, windowOpen: new Date(now - DEMO_PROGRAM.openedAgoMs).toISOString(), windowClose: new Date(now + DEMO_PROGRAM.closesInMs).toISOString() }).success).toBe(true);
    expect(new Set(DEMO_SESSIONS.map((s) => s.week)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(DEMO_SESSIONS.map((s) => s.ageGroup)).size).toBeGreaterThanOrEqual(2);
  });

  it('gives every child one age group in every ranked week, and submissions inside the open window', () => {
    for (const f of DEMO_FAMILIES) {
      expect(f.appliedAfterHours * 3600_000).toBeLessThan(DEMO_PROGRAM.openedAgoMs);
      for (const c of f.children) {
        const weeks = new Map(weeksForChild(`${c.birthdate}T00:00:00.000Z`, sessionsRows).map((w) => [w.week, w.ageGroup]));
        for (const w of c.rankedWeeks) expect(weeks.get(w), `${c.firstName} ${w}`).toBeTruthy();
        expect(c.requested).toBeLessThanOrEqual(Math.min(DEMO_PROGRAM.maxWeeks, c.rankedWeeks.length));
      }
      if (f.siblingMode === 'together_only') {
        const common = f.children.map((c) => new Set(c.rankedWeeks)).reduce((a, b) => new Set([...a].filter((w) => b.has(w))));
        expect(common.size, f.key).toBeGreaterThan(0);
      }
    }
  });

  it('covers family sizes 1-3 and all three sibling modes', () => {
    expect(new Set(DEMO_FAMILIES.map((f) => f.children.length))).toEqual(new Set([1, 2, 3]));
    expect(new Set(DEMO_FAMILIES.filter((f) => f.children.length > 1).map((f) => f.siblingMode))).toEqual(new Set(['together_only', 'together_preferred', 'independent']));
  });

  it('oversubscribes Week 1 ages 8-10 (14 children for 3 seats)', () => {
    const seats = DEMO_SESSIONS.find((s) => s.week === DEMO_OVERSUBSCRIBED.week && s.ageGroup === DEMO_OVERSUBSCRIBED.ageGroup)?.capacity ?? 0;
    const ranking = DEMO_FAMILIES.flatMap((f) => f.children).filter((c) => c.rankedWeeks.includes(DEMO_OVERSUBSCRIBED.week) && weeksForChild(`${c.birthdate}T00:00:00.000Z`, sessionsRows).find((w) => w.week === DEMO_OVERSUBSCRIBED.week)?.ageGroup === DEMO_OVERSUBSCRIBED.ageGroup);
    expect(seats).toBe(3);
    expect(ranking).toHaveLength(14);
  });

  it('uses a real applicant for the duplicate child and two age groups for the rollback pair', () => {
    const rivera = DEMO_FAMILIES.find((f) => f.key === DEMO_DUPLICATE_CHILD.familyKey);
    expect(rivera?.children.some((c) => c.firstName === DEMO_DUPLICATE_CHILD.firstName && c.birthdate === DEMO_DUPLICATE_CHILD.birthdate)).toBe(true);
    const groups = DEMO_ROLLBACK_FAMILY.children.map((c) => weeksForChild(`${c.birthdate}T00:00:00.000Z`, sessionsRows)[0]?.ageGroup);
    expect(groups).toEqual(DEMO_ROLLBACK_FAMILY.children.map((c) => c.ageGroup));
    expect(new Set(groups).size).toBe(2);
    expect(DEMO_FAMILIES.some((f) => f.key === DEMO_ROLLBACK_FAMILY.key)).toBe(false); // not in the draw
  });
});
