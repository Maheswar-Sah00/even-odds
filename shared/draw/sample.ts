import type { DrawInputs } from './plan.ts';

/**
 * SYNTHETIC sample inputs for the browser replay page and the golden tests.
 * Covers every rule: an approved override, tiers, a late applicant, a
 * withdrawal, together-only, together-preferred, an impossible preference and
 * two snake rounds.
 */
export const SAMPLE_SEED = '7f3a9c2b8e1d4f6a0b5c9e8d7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b';

export const SAMPLE_INPUTS: DrawInputs = {
  schema: 'draw-inputs-v1',
  algorithm: 'even-odds-draw-v1',
  programId: 'synthetic-sample',
  maxWeeks: 2,
  sessions: [
    { week: 'W1', ageGroup: 'young', capacity: 2 },
    { week: 'W1', ageGroup: 'old', capacity: 1 },
    { week: 'W2', ageGroup: 'young', capacity: 1 },
    { week: 'W2', ageGroup: 'old', capacity: 2 },
  ],
  applications: [
    { publicId: 'a1', tier: 0, late: false, siblingMode: 'together_only', children: [
      { ref: 'a1-c1', rankedWeeks: ['W1', 'W2'], ageGroups: ['young', 'young'], requested: 1 },
      { ref: 'a1-c2', rankedWeeks: ['W1', 'W2'], ageGroups: ['old', 'old'], requested: 1 },
    ] },
    { publicId: 'b2', tier: 1, late: false, siblingMode: 'independent', children: [{ ref: 'b2-c1', rankedWeeks: ['W1', 'W2'], ageGroups: ['young', 'young'], requested: 2 }] },
    { publicId: 'c3', tier: 1, late: false, siblingMode: 'together_preferred', children: [
      { ref: 'c3-c1', rankedWeeks: ['W2', 'W1'], ageGroups: ['old', 'old'], requested: 1 },
      { ref: 'c3-c2', rankedWeeks: ['W1'], ageGroups: ['young'], requested: 1 },
    ] },
    { publicId: 'd4', tier: 1, late: true, siblingMode: 'independent', children: [{ ref: 'd4-c1', rankedWeeks: ['W1', 'W2'], ageGroups: ['young', 'young'], requested: 1 }] },
    { publicId: 'e5', tier: 1, late: false, siblingMode: 'independent', withdrawn: true, children: [{ ref: 'e5-c1', rankedWeeks: ['W1'], ageGroups: ['young'], requested: 1 }] },
    { publicId: 'f6', tier: 2, late: false, siblingMode: 'independent', children: [{ ref: 'f6-c1', rankedWeeks: ['W2', 'W9'], ageGroups: ['old', 'old'], requested: 1 }] },
  ],
  overrides: [{ publicId: 'f6', reasonCode: 'accommodation', pool: 'accommodation' }],
};
