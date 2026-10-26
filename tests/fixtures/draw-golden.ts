import { SAMPLE_INPUTS, SAMPLE_SEED } from '../../shared/draw/sample.ts';

/**
 * Golden fixture shared by the Node unit test and the browser (Playwright)
 * parity test: the synthetic sample from shared/draw/sample.ts. If the
 * algorithm changes, GOLDEN_PLAN_HASH must change deliberately, with a
 * version bump.
 */
export const GOLDEN_INPUTS = SAMPLE_INPUTS;
export const GOLDEN_SEED = SAMPLE_SEED;

/** planHash(computePlan(GOLDEN_INPUTS, GOLDEN_SEED)); hand-verified step by step (docs/DRAW-ALGORITHM.md). */
export const GOLDEN_PLAN_HASH = 'e14e914f9c7e8783da71875c6097f748c7635dc820878d15d8122f87214966ee';
