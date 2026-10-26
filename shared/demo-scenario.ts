import type { SessionRow, ZoneInput } from './program-input.ts';
import type { SiblingMode } from './draw/plan.ts';
import type { LngLat } from './geo.ts';

/**
 * The judge-sandbox scenario (Task 12). Hand-written and deterministic, so
 * every demonstration is guaranteed by the data rather than by chance:
 *
 * - 4 camp weeks x 2 age groups; "Week 1, ages 8-10" has 3 seats and 14
 *   children ranking it: oversubscribed about 4.7 times.
 * - 16 SYNTHETIC applicant households of 1-3 children in all three sibling
 *   modes and all three priority tiers, with application times spread over
 *   the window (some near zone edges, for the verification queue).
 * - The Rivera household's Maya is the duplicate-child demonstration: a
 *   second household registering the same child is refused by the unique
 *   index on (program, child_key).
 * - The Brooks household (not an applicant) is the full-seat rollback
 *   demonstration: two siblings in different age groups, one of them full.
 *
 * Every name is prefixed "[SYNTHETIC]" when written to the database.
 */

export const DEMO_SCENARIO_VERSION = 'judge-sandbox-v1';

export const DEMO_PROGRAM = {
  name: '[SYNTHETIC] Judge sandbox: Maple Valley Day Camp 2027',
  description:
    'A private, pre-seeded demonstration program. Every family, child and home in it is synthetic. Use the demo controls to fast-forward to the close, watch the freeze and a live drand round, run the draw and replay it.',
  timezone: 'America/New_York',
  maxWeeks: 2,
  defaultTier: 2,
  tierLabels: { '0': 'Maple Valley residents', '1': 'Neighbouring towns', '2': 'Everyone else' },
  sourceNote: 'Synthetic judge sandbox: families, children, homes and zones are invented. Private to your demo session.',
  /** Window relative to the reset: opened 5 days ago, closes in 2 days (demo time can fast-forward it). */
  openedAgoMs: 5 * 86400_000,
  closesInMs: 2 * 86400_000,
} as const;

export const DEMO_SESSIONS: readonly SessionRow[] = [
  { week: '2027-W25', weekStart: '2027-06-21', ageGroup: '5-7', minAge: 5, maxAge: 7, capacity: 5, label: 'Week 1: Jun 21-25' },
  { week: '2027-W25', weekStart: '2027-06-21', ageGroup: '8-10', minAge: 8, maxAge: 10, capacity: 3, label: 'Week 1: Jun 21-25' },
  { week: '2027-W26', weekStart: '2027-06-28', ageGroup: '5-7', minAge: 5, maxAge: 7, capacity: 4, label: 'Week 2: Jun 28-Jul 2' },
  { week: '2027-W26', weekStart: '2027-06-28', ageGroup: '8-10', minAge: 8, maxAge: 10, capacity: 4, label: 'Week 2: Jun 28-Jul 2' },
  { week: '2027-W27', weekStart: '2027-07-05', ageGroup: '5-7', minAge: 5, maxAge: 7, capacity: 3, label: 'Week 3: Jul 5-9' },
  { week: '2027-W27', weekStart: '2027-07-05', ageGroup: '8-10', minAge: 8, maxAge: 10, capacity: 4, label: 'Week 3: Jul 5-9' },
  { week: '2027-W28', weekStart: '2027-07-12', ageGroup: '5-7', minAge: 5, maxAge: 7, capacity: 4, label: 'Week 4: Jul 12-16' },
  { week: '2027-W28', weekStart: '2027-07-12', ageGroup: '8-10', minAge: 8, maxAge: 10, capacity: 4, label: 'Week 4: Jul 12-16' },
];

export const DEMO_OVERSUBSCRIBED = { week: '2027-W25', ageGroup: '8-10' } as const;

const square = (w: number, s: number, e: number, n: number): LngLat[][] => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];

/** [longitude, latitude]; the core square sits inside the outer one. */
export const DEMO_ZONES: readonly ZoneInput[] = [
  { name: 'Maple Valley (synthetic)', tier: 0, area: square(-77.32, 38.835, -77.29, 38.86) },
  { name: 'Neighbouring towns (synthetic)', tier: 1, area: square(-77.36, 38.81, -77.25, 38.89) },
];

const W1 = '2027-W25';
const W2 = '2027-W26';
const W3 = '2027-W27';
const W4 = '2027-W28';

/** Home points by intended tier ("edge" = within 50 m of a zone boundary). */
const HOME = {
  core: (i: number): LngLat => [-77.312 + i * 0.002, 38.846],
  coreEdge: (i: number): LngLat => [-77.2905, 38.842 + i * 0.002],
  outer: (i: number): LngLat => [-77.345 + i * 0.003, 38.82],
  outerEdge: (i: number): LngLat => [-77.2895, 38.844 + i * 0.002],
  outside: (i: number): LngLat => [-77.2 + i * 0.004, 38.86],
} as const;

export interface DemoChild {
  firstName: string;
  lastName: string;
  /** Chosen so the age group is the same in every week (no birthdays between Jun 21 and Jul 16). */
  birthdate: string;
  rankedWeeks: string[];
  requested: number;
}

export interface DemoFamily {
  key: string;
  label: string;
  home: LngLat;
  siblingMode: SiblingMode;
  /** Submission time as hours after the window opened (spread across the window). */
  appliedAfterHours: number;
  children: DemoChild[];
  /** What this household demonstrates, shown in the demo guide. */
  note?: string;
}

const kid = (firstName: string, lastName: string, birthdate: string, rankedWeeks: string[], requested = 1): DemoChild => ({ firstName, lastName, birthdate, rankedWeeks, requested });

export const DEMO_FAMILIES: readonly DemoFamily[] = [
  {
    key: 'rivera',
    label: 'Rivera household',
    home: HOME.core(0),
    siblingMode: 'together_only',
    appliedAfterHours: 3,
    children: [kid('Maya', 'Rivera', '2020-09-14', [W1, W2], 2), kid('Leo', 'Rivera', '2017-10-02', [W1, W2], 2)],
    note: 'Together only, two age groups. Maya is the duplicate-child demonstration.',
  },
  { key: 'chen', label: 'Chen household', home: HOME.core(1), siblingMode: 'independent', appliedAfterHours: 30, children: [kid('Ava', 'Chen', '2017-12-20', [W1, W3])] },
  {
    key: 'okafor',
    label: 'Okafor household',
    home: HOME.outer(0),
    siblingMode: 'together_preferred',
    appliedAfterHours: 12,
    children: [kid('Chidi', 'Okafor', '2020-11-05', [W1, W2, W4], 2), kid('Ada', 'Okafor', '2018-09-22', [W1, W2, W4], 2), kid('Emeka', 'Okafor', '2016-10-30', [W1, W2, W4], 2)],
    note: 'Three children, together preferred: kept together where possible, otherwise placed one by one.',
  },
  { key: 'novak', label: 'Novak household', home: HOME.outer(1), siblingMode: 'independent', appliedAfterHours: 50, children: [kid('Lena', 'Novak', '2019-11-11', [W2, W1])] },
  {
    key: 'haddad',
    label: 'Haddad household',
    home: HOME.outside(0),
    siblingMode: 'independent',
    appliedAfterHours: 8,
    children: [kid('Omar', 'Haddad', '2021-10-09', [W1, W4]), kid('Layla', 'Haddad', '2017-09-18', [W1, W4])],
  },
  { key: 'silva', label: 'Silva household', home: HOME.outside(1), siblingMode: 'independent', appliedAfterHours: 2, children: [kid('Rafael', 'Silva', '2016-12-03', [W1, W2])] },
  {
    key: 'kowalski',
    label: 'Kowalski household',
    home: HOME.outerEdge(0),
    siblingMode: 'together_only',
    appliedAfterHours: 40,
    children: [kid('Zofia', 'Kowalski', '2018-10-14', [W1, W3]), kid('Jan', 'Kowalski', '2016-11-25', [W1, W3])],
    note: 'Home 40 m outside the Maple Valley boundary: flagged for verification.',
  },
  { key: 'nguyen', label: 'Nguyen household', home: HOME.core(2), siblingMode: 'independent', appliedAfterHours: 70, children: [kid('Minh', 'Nguyen', '2020-08-30', [W3, W4])] },
  {
    key: 'patel',
    label: 'Patel household',
    home: HOME.outside(2),
    siblingMode: 'together_only',
    appliedAfterHours: 20,
    children: [kid('Asha', 'Patel', '2020-12-12', [W2, W3]), kid('Dev', 'Patel', '2020-12-12', [W2, W3])],
    note: 'Twins, together only.',
  },
  { key: 'johansson', label: 'Johansson household', home: HOME.outer(2), siblingMode: 'independent', appliedAfterHours: 118, children: [kid('Elsa', 'Johansson', '2017-11-08', [W1, W4])], note: 'Applied most recently: no disadvantage in a lottery.' },
  { key: 'mensah', label: 'Mensah household', home: HOME.outside(3), siblingMode: 'independent', appliedAfterHours: 0.02, children: [kid('Kofi', 'Mensah', '2018-08-29', [W1, W2])], note: 'Applied in the first minute: no advantage in a lottery.' },
  {
    key: 'dubois',
    label: 'Dubois household',
    home: HOME.coreEdge(0),
    siblingMode: 'together_preferred',
    appliedAfterHours: 60,
    children: [kid('Chloe', 'Dubois', '2021-09-01', [W4, W1]), kid('Hugo', 'Dubois', '2018-12-01', [W4, W1])],
    note: 'Home 40 m inside the Maple Valley boundary: flagged for verification.',
  },
  { key: 'ito', label: 'Ito household', home: HOME.outside(4), siblingMode: 'independent', appliedAfterHours: 90, children: [kid('Haru', 'Ito', '2016-09-19', [W1, W3])] },
  {
    key: 'garcia',
    label: 'Garcia household',
    home: HOME.outside(5),
    siblingMode: 'independent',
    appliedAfterHours: 26,
    children: [kid('Sofia', 'Garcia', '2021-11-20', [W2, W3, W4], 2), kid('Mateo', 'Garcia', '2019-10-10', [W2, W3, W4], 2), kid('Lucia', 'Garcia', '2017-08-28', [W2, W3, W4], 2)],
  },
  { key: 'petrov', label: 'Petrov household', home: HOME.core(3), siblingMode: 'independent', appliedAfterHours: 100, children: [kid('Ivan', 'Petrov', '2017-09-09', [W1, W2])] },
  {
    key: 'ali',
    label: 'Ali household',
    home: HOME.outer(3),
    siblingMode: 'together_only',
    appliedAfterHours: 15,
    children: [kid('Noor', 'Ali', '2020-10-17', [W1, W4]), kid('Zain', 'Ali', '2017-10-27', [W1, W4])],
  },
];

/** Not an applicant: the sibling pair used by the full-seat rollback demonstration. */
export const DEMO_ROLLBACK_FAMILY = {
  key: 'brooks',
  label: 'Brooks household (rollback demonstration, not in the draw)',
  children: [
    { firstName: 'Ella', lastName: 'Brooks', birthdate: '2020-10-01', ageGroup: '5-7' },
    { firstName: 'Sam', lastName: 'Brooks', birthdate: '2017-10-01', ageGroup: '8-10' },
  ],
} as const;

/** The duplicate-child demonstration: the same child as the Rivera household's Maya. */
export const DEMO_DUPLICATE_CHILD = { familyKey: 'rivera', firstName: 'Maya', lastName: 'Rivera', birthdate: '2020-09-14' } as const;

export const syntheticName = (name: string) => `[SYNTHETIC] ${name}`;
