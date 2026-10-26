// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { submitApplicationSchema } from '../../shared/application-input.ts';
import { ageOn, weeksForChild } from '../../shared/eligibility.ts';

const s = (week: string, start: string, group: string, min: number, max: number) => ({ week, week_start: `${start}T00:00:00.000Z`, age_group: group, min_age: min, max_age: max, capacity: 10, label: null });

describe('ageOn', () => {
  it('counts whole years, turning a year older exactly on the birthday', () => {
    expect(ageOn('2019-06-21', '2027-06-20')).toBe(7);
    expect(ageOn('2019-06-21', '2027-06-21')).toBe(8);
    expect(ageOn('2020-02-29', '2027-02-28')).toBe(6);
    expect(ageOn('2020-02-29', '2027-03-01')).toBe(7);
  });
});

describe('weeksForChild', () => {
  const sessions = [s('W1', '2027-06-21', '6-8', 6, 8), s('W1', '2027-06-21', '9-11', 9, 11), s('W2', '2027-06-28', '6-8', 6, 8), s('W3', '2027-07-05', '9-11', 9, 11)];

  it('uses age on the first day of each week, so a birthday mid-summer changes the group', () => {
    // Turns 9 on 2027-06-25: 8 on W1 start, 9 on W2 and W3 start.
    const w = weeksForChild('2018-06-25', sessions);
    expect(w.map((x) => [x.week, x.age, x.ageGroup])).toEqual([
      ['W1', 8, '6-8'],
      ['W2', 9, null],
      ['W3', 9, '9-11'],
    ]);
    expect(w[1]?.reason).toMatch(/ages 6–8/);
  });

  it('reports overlapping age groups as ambiguous instead of guessing', () => {
    const w = weeksForChild('2019-01-01', [s('W1', '2027-06-21', 'a', 6, 8), s('W1', '2027-06-21', 'b', 8, 10)]);
    expect(w[0]).toMatchObject({ ageGroup: null, reason: expect.stringMatching(/more than one age group/) as unknown });
  });
});

describe('submitApplicationSchema', () => {
  const valid = { programId: 'p', siblingMode: 'independent', children: [{ childId: 'c', rankedWeeks: ['W1', 'W2'], requestedWeeks: 1 }], idempotencyKey: 'x'.repeat(32) };

  it('accepts choices only', () => {
    expect(submitApplicationSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    [{ ...valid, claimed_tier: 0 }, 'extra top-level field'],
    [{ ...valid, children: [{ ...valid.children[0], verified_tier: 0 }] }, 'extra child field'],
    [{ ...valid, children: [{ childId: 'c', rankedWeeks: ['W1', 'W1'], requestedWeeks: 1 }] }, 'repeated week'],
    [{ ...valid, children: [valid.children[0], valid.children[0]] }, 'repeated child'],
    [{ ...valid, siblingMode: 'whatever' }, 'unknown sibling mode'],
    [{ ...valid, idempotencyKey: 'short' }, 'weak idempotency key'],
  ] as [unknown, string][])('rejects %#: %s', (input) => {
    expect(submitApplicationSchema.safeParse(input).success).toBe(false);
  });
});
