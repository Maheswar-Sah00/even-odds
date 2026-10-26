import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createServerAppwrite } from '../../functions/shared/appwrite-server.ts';
import { createServerDb } from '../../functions/shared/db.ts';
import { destroySandbox } from '../../functions/shared/sandbox.ts';
import { loadServerEnv } from '../../functions/shared/server-env.ts';

/**
 * The judge's path through the product, in a real browser against the real
 * backend: start (guest session), duplicate child, fast-forward + freeze,
 * live drand draw, rollback, a family reply, 48 h fast-forward, replay.
 * Screenshots go to test-results/judge-demo/.
 */
/** Task 14: every screen of the walkthrough is also scanned for WCAG 2.1 AA violations (axe-core). */
const violations: string[] = [];
async function shot(page: Page, name: string) {
  await page.screenshot({ path: `test-results/judge-demo/${name}.png`, fullPage: true });
  const { violations: found } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  for (const v of found) violations.push(`${name}: ${v.id} (${v.impact ?? '?'}) ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}
const inspector = (page: Page) => page.locator('section.card', { hasText: 'Database inspector' });

/** The sandbox program ID is in the replay link; its owner is this run's guest user (cleaned up afterwards). */
let programId: string | null = null;

test.afterAll(async () => {
  const env = loadServerEnv();
  if (!programId || !env.ok) return;
  const aw = createServerAppwrite(env.config, { sink: null });
  const db = createServerDb(aw);
  const owner = (await db.getRow('programs', programId).catch(() => null))?.sandbox_owner;
  if (!owner) return;
  await destroySandbox(aw, db, owner).catch(() => undefined);
  await aw.users.delete({ userId: owner }).catch(() => undefined);
});

test('a judge can run the whole demo with no setup', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.getByRole('link', { name: 'Try the judge demo' }).click();
  await page.getByRole('button', { name: 'Start the judge demo' }).click();
  await expect(page.getByRole('heading', { name: 'Demo script' })).toBeVisible({ timeout: 90_000 });
  programId = (await page.getByRole('link', { name: 'Replay the draw' }).first().getAttribute('href'))?.split('/').pop() ?? null;
  await expect(page.getByText('Judge sandbox: everything here is synthetic')).toBeVisible();
  await shot(page, '01-sandbox');

  await page.getByRole('button', { name: 'Register Maya again from a second household' }).click();
  await expect(inspector(page).getByText(/Refused by the unique index uq_program_child_key/)).toBeVisible();
  await shot(page, '02-duplicate');

  // Dialog focus management (keyboard only): focus moves into the dialog, Escape closes it and
  // returns focus to the button that opened it; reopening works the same way.
  const fastForward = page.getByRole('button', { name: 'Fast-forward to the close' });
  await fastForward.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.closest('dialog') !== null)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(fastForward).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: 'Close and freeze' }).click();
  await expect(inspector(page).getByText(/Inputs hash [0-9a-f]{64}/)).toBeVisible();
  await shot(page, '03-frozen');

  await page.getByRole('button', { name: 'Run the draw' }).click();
  await expect(inspector(page).getByText(/Draw committed: \d+ placements/)).toBeVisible({ timeout: 180_000 });
  await shot(page, '04-drawn');

  await page.getByRole('button', { name: 'Squeeze a sibling pair into a full week' }).click();
  await expect(inspector(page).getByText(/The whole transaction was rolled back/)).toBeVisible();
  await shot(page, '05-rollback');

  await page.getByRole('button', { name: /^Decline/ }).first().click();
  await expect(inspector(page).getByText(/offer\(s\) moved offered → declined/)).toBeVisible();

  await page.getByRole('button', { name: 'Fast-forward 48 hours' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Expire pending offers' }).click();
  await expect(inspector(page).getByText(/offer\(s\) expired/)).toBeVisible({ timeout: 180_000 });
  await shot(page, '06-expired');

  await page.getByRole('tab', { name: 'Audit & fairness' }).click();
  const invariant = (label: string) => page.locator('li', { hasText: label }).first();
  await expect(invariant('oversold seats')).toHaveText(/^\s*0\s+oversold seats/, { timeout: 60_000 });
  await expect(invariant('"together only" families split')).toHaveText(/^\s*0\s+"together only" families split/);
  await shot(page, '07-fairness');

  await page.getByRole('link', { name: 'Replay the draw' }).first().click();
  await page.waitForURL(/\/replay\//);
  await expect(page.getByRole('heading', { level: 1, name: 'Replay the draw' })).toBeVisible();
  await page.getByRole('button', { name: 'Verify the published draw' }).click();
  // Pass details that only the in-browser verifier produces (shared/freeze + shared/draw, run here).
  await expect(page.getByText(/logged when this demo sandbox was fast-forwarded to its close/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/plan hash [0-9a-f]{12}… matches the draw/)).toBeVisible({ timeout: 120_000 });
  // Task 13: the committed placements (published result) equal the replay, and the whole log is intact.
  await expect(page.getByText('Reproduced independently')).toBeVisible();
  await expect(page.locator('[data-step=compare][data-status=pass]')).toBeVisible();
  await expect(page.locator('[data-step=audit][data-status=pass]')).toBeVisible();
  // Deliberately modifying a published artifact makes verification fail.
  await page.getByRole('button', { name: 'Change the published inputs hash' }).click();
  await expect(page.locator('[data-step=inputs_hash][data-status=fail]')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Restore the published copy' }).click();
  await expect(page.getByText('Reproduced independently')).toBeVisible({ timeout: 120_000 });
  await shot(page, '08-replay');

  // Public fairness report card, computed in this browser from the artifacts the replay verifies.
  await page.getByRole('link', { name: 'Fairness report' }).first().click();
  await page.waitForURL(/\/fairness\//);
  await expect(page.getByRole('heading', { level: 1, name: 'Fairness report card' })).toBeVisible();
  await expect(page.getByText('seats allocated by the draw')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('li', { hasText: 'oversold seats' }).first()).toHaveText(/^\s*0\s+oversold seats/);
  await expect(page.getByRole('heading', { name: 'Comparison: first come, first served' })).toBeVisible();
  await shot(page, '09-fairness-public');
  await page.goto(`/audit/${programId ?? ''}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, '10-audit-public');
  expect(errors).toEqual([]);
  expect(violations).toEqual([]);
});
