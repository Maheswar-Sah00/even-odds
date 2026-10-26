import { expect, test } from '@playwright/test';
import { canonicalJson, computePlan, planHash, type DrawApplication, type DrawInputs } from '../../shared/draw/index.ts';
import { mulberry32 } from '../../shared/odds.ts';
import { GOLDEN_INPUTS, GOLDEN_PLAN_HASH, GOLDEN_SEED } from '../fixtures/draw-golden.ts';

/**
 * Node.js vs browser parity for the draw module: the SAME source file
 * (shared/draw) is imported into Chromium through the Vite dev server and must
 * produce byte-identical plans. Differences are failures, never rounded away.
 */
function generated(n: number): { inputs: DrawInputs; seed: string } {
  const rng = mulberry32(9000 + n);
  const weeks = ['W1', 'W2', 'W3'];
  const applications: DrawApplication[] = Array.from({ length: 3 + Math.floor(rng() * 20) }, (_, i) => ({
    publicId: `p${String(n)}-${String(i)}-${Math.floor(rng() * 1e9).toString(36)}`,
    tier: Math.floor(rng() * 3),
    late: rng() < 0.1,
    siblingMode: (['together_only', 'together_preferred', 'independent'] as const)[Math.floor(rng() * 3)] ?? 'independent',
    children: Array.from({ length: 1 + Math.floor(rng() * 3) }, (_, k) => {
      const ranked = [...weeks].sort(() => rng() - 0.5).slice(0, 1 + Math.floor(rng() * 3));
      const g = rng() < 0.5 ? 'young' : 'old';
      return { ref: `r${String(n)}-${String(i)}-${String(k)}`, rankedWeeks: ranked, ageGroups: ranked.map(() => g), requested: 1 + Math.floor(rng() * 2) };
    }),
  }));
  const seed = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('');
  return {
    seed,
    inputs: {
      schema: 'draw-inputs-v1',
      algorithm: 'even-odds-draw-v1',
      programId: `gen-${String(n)}`,
      maxWeeks: 2,
      sessions: weeks.flatMap((w) => ['young', 'old'].map((g) => ({ week: w, ageGroup: g, capacity: Math.floor(rng() * 5) }))),
      applications,
      overrides: rng() < 0.5 && applications[0] ? [{ publicId: applications[0].publicId, reasonCode: 'accommodation', pool: 'accommodation' }] : [],
    },
  };
}

test('the browser computes byte-identical plans to Node.js', async ({ page }) => {
  await page.goto('/');
  const cases = [{ inputs: GOLDEN_INPUTS, seed: GOLDEN_SEED }, ...Array.from({ length: 25 }, (_, n) => generated(n))];
  const nodeResults = cases.map((c) => {
    const plan = computePlan(c.inputs, c.seed);
    return { hash: planHash(plan), json: canonicalJson(plan) };
  });
  expect(nodeResults[0]?.hash).toBe(GOLDEN_PLAN_HASH);

  const browserResults = await page.evaluate(async (all) => {
    const modulePath = '/shared/draw/index.ts'; // served by the Vite dev server: the same source file Node imported
    const draw = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../shared/draw/index.ts');
    return all.map((c) => {
      const plan = draw.computePlan(c.inputs, c.seed);
      return { hash: draw.planHash(plan), json: draw.canonicalJson(plan) };
    });
  }, cases);

  expect(browserResults).toHaveLength(nodeResults.length);
  browserResults.forEach((b, i) => {
    expect(b.hash, `case ${String(i)}`).toBe(nodeResults[i]?.hash);
    expect(b.json, `case ${String(i)}`).toBe(nodeResults[i]?.json);
  });
});

test('the public replay page reproduces the golden plan hash through the real UI', async ({ page }) => {
  await page.goto('/replay/demo');
  await page.getByText('Show the manual replay').click();
  await page.getByRole('button', { name: 'Try with synthetic sample data' }).click();
  await expect(page.getByText(GOLDEN_PLAN_HASH)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Lottery order' })).toBeVisible();
});
