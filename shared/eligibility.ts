/**
 * Age eligibility, shared by the wizard (to show options) and the server (to
 * enforce them). Age is computed as of each week's start date (brief §5).
 */

/** Whole years between a birthdate and a date (both ISO; only the date part is used). */
export function ageOn(birthdate: string, onDate: string): number {
  const [by, bm, bd] = birthdate.slice(0, 10).split('-').map(Number) as [number, number, number];
  const [y, m, d] = onDate.slice(0, 10).split('-').map(Number) as [number, number, number];
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age;
}

export interface SessionLike {
  week: string;
  week_start: string;
  age_group: string;
  min_age: number;
  max_age: number;
  capacity: number;
}

export interface WeekEligibility {
  week: string;
  weekStart: string;
  label: string | null;
  /** The single age group the child falls into that week, if any. */
  ageGroup: string | null;
  age: number;
  reason: string | null;
}

/**
 * For each week of a program, which age group (if any) a child belongs to.
 * If age groups overlap and a child fits two, the week is reported as
 * ambiguous rather than guessed.
 */
export function weeksForChild(birthdate: string, sessions: readonly (SessionLike & { label?: string | null })[]): WeekEligibility[] {
  const weeks = new Map<string, (SessionLike & { label?: string | null })[]>();
  for (const s of sessions) weeks.set(s.week, [...(weeks.get(s.week) ?? []), s]);
  return [...weeks.entries()]
    .map(([week, list]) => {
      const weekStart = list[0]?.week_start ?? '';
      const age = ageOn(birthdate, weekStart);
      const fits = list.filter((s) => age >= s.min_age && age <= s.max_age);
      const label = list[0]?.label ?? null;
      if (fits.length === 1) return { week, weekStart, label, ageGroup: fits[0]?.age_group ?? null, age, reason: null };
      if (fits.length > 1) return { week, weekStart, label, ageGroup: null, age, reason: `Age ${String(age)} fits more than one age group this week; ask the organiser.` };
      return { week, weekStart, label, ageGroup: null, age, reason: `Age ${String(age)} on the first day; this week is for ages ${list.map((s) => `${String(s.min_age)}–${String(s.max_age)}`).join(', ')}.` };
    })
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export const SIBLING_MODE_TEXT = {
  together_only: {
    title: 'Together only',
    body: 'Your children are placed as one group or not at all. A week only counts if every child you entered gets a place in it. If any child is left out, nobody is placed that week.',
  },
  together_preferred: {
    title: 'Together preferred',
    body: 'We first try to place all your children in the same week. If that is not possible, each child is then tried on their own, so they may end up in different weeks.',
  },
  independent: {
    title: 'Independent',
    body: 'Each child is treated separately, as if from different families. This gives each child the most chances but siblings may attend different weeks.',
  },
} as const;

export const HONESTY_NOTE =
  'Rank weeks in the order you really prefer them. In the first round, ranking your true favourite first can never hurt your chance of getting it. In later rounds (second or third weeks) the draft is not fully strategy-proof, but misreporting is very unlikely to help and can easily backfire.';

export const ODDS_CAVEAT = 'Odds shown in Even Odds are estimates based on current demand, updated hourly. They are not a promise: the actual result depends on the public random draw after applications close.';
