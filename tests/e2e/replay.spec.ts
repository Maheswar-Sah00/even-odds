import { expect, test } from '@playwright/test';
import { replayBundle, serializeBundle, tamper, TAMPERS, type TamperKey } from '../../shared/replay/index.ts';
import { publishedFixture, ROUND_AT } from '../fixtures/replay-bundle.ts';

/**
 * The independent replay in a real browser, offline: Chromium loads the SAME
 * shared/replay sources through Vite (real drand-client BLS code) and must
 * reach exactly the verdicts Node.js reaches, for the honest publication and
 * for every deliberate modification. Then the page itself verifies a bundle
 * file and a modified copy.
 */
const NOW = ROUND_AT + 3600_000;
const verdicts = (v: Awaited<ReturnType<typeof replayBundle>>) => ({ steps: v.steps.map((s) => [s.key, s.status, s.summary]), matches: v.replayMatches, planHash: v.planHash });

test('the browser replay reaches the same verdicts as Node.js, honest and tampered', async ({ page }) => {
  await page.goto('/');
  const { bundle } = publishedFixture();
  const keys = Object.keys(TAMPERS) as TamperKey[];
  const node = [verdicts(await replayBundle(bundle, { now: NOW })), ...(await Promise.all(keys.map(async (k) => verdicts(await replayBundle(tamper(bundle, k), { now: NOW })))))];

  const browser = await page.evaluate(
    async ({ b, now, ks }) => {
      const path = '/shared/replay/index.ts';
      const r = (await import(/* @vite-ignore */ path)) as typeof import('../../shared/replay/index.ts');
      const out = async (x: typeof b) => {
        const v = await r.replayBundle(x, { now });
        return { steps: v.steps.map((s) => [s.key, s.status, s.summary]), matches: v.replayMatches, planHash: v.planHash };
      };
      return [await out(b), ...(await Promise.all(ks.map((k) => out(r.tamper(b, k)))))];
    },
    { b: bundle, now: NOW, ks: keys },
  );
  expect(browser).toEqual(node);
  expect(node[0]?.matches).toBe(true);
  for (const [i, k] of keys.entries()) expect(node[i + 1]?.steps.find((s) => s[0] === TAMPERS[k].failsAt)?.[1], k).toBe('fail');
});

test('the replay page verifies a downloaded bundle offline and fails a modified copy', async ({ page }) => {
  const { bundle } = publishedFixture();
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto('/replay/synthetic-sample');
  await expect(page.getByRole('heading', { level: 1, name: 'Replay the draw' })).toBeVisible();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'bundle.json', mimeType: 'application/json', buffer: Buffer.from(serializeBundle(bundle)) });
  await expect(page.getByText('Reproduced independently')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/plan hash [0-9a-f]{12}… matches the draw/)).toBeVisible();
  await expect(page.getByRole('table', { name: /Applications/ })).toBeVisible();

  await page.getByRole('button', { name: TAMPERS.beacon.label }).click();
  await expect(page.getByText(/Verification failed at/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Verification now fails at "drand beacon signature"/)).toBeVisible();
  await expect(page.locator('[data-step=beacon][data-status=fail]')).toBeVisible();
});
