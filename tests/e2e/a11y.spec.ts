import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { serializeBundle } from '../../shared/replay/index.ts';
import { publishedFixture, ROUND_AT } from '../fixtures/replay-bundle.ts';

/**
 * Task 14 accessibility audit (WCAG 2.1 AA), offline. axe-core checks what can
 * be checked automatically (names, roles, contrast, landmarks, ARIA); the
 * tests below cover what it cannot: keyboard-only use, focus order, reflow at
 * 320 CSS px (= 1280 px at 400% zoom), reduced motion and the text alternative
 * to the replay. Data-heavy screens are scanned again in the live walkthrough
 * (tests/e2e-live/judge-demo.spec.ts). Results: docs/TEST-REPORT.md.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export async function axeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  return violations.map((v) => `${v.id} (${v.impact ?? '?'}): ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

const ROUTES = ['/', '/programs', '/programs/p1', '/family', '/family/children', '/applications/new/p1', '/applications/a1', '/organiser', '/organiser/programs/p1', '/audit/p1', '/replay/p1', '/fairness/p1', '/status', '/demo', '/nope'];

for (const path of ROUTES) {
  test(`axe: ${path} has no WCAG 2.1 AA violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('axe: the replay page after verifying a bundle (results, tables, tamper controls)', async ({ page }) => {
  await page.clock.setFixedTime(new Date(ROUND_AT + 3600_000));
  await page.goto('/replay/synthetic-sample');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'bundle.json', mimeType: 'application/json', buffer: Buffer.from(serializeBundle(publishedFixture().bundle)) });
  await expect(page.getByText('Reproduced independently')).toBeVisible({ timeout: 60_000 });
  expect(await axeViolations(page)).toEqual([]);
});

test('the replay is available as text tables, with results announced politely', async ({ page }) => {
  await page.clock.setFixedTime(new Date(ROUND_AT + 3600_000));
  await page.goto('/replay/synthetic-sample');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'bundle.json', mimeType: 'application/json', buffer: Buffer.from(serializeBundle(publishedFixture().bundle)) });
  await expect(page.getByText('Reproduced independently')).toBeVisible({ timeout: 60_000 });
  // Every table has an accessible name (caption) and header cells.
  const tables = page.getByRole('table');
  expect(await tables.count()).toBeGreaterThan(0);
  for (const t of await tables.all()) {
    expect(await t.evaluate((el) => (el as HTMLTableElement).caption?.textContent.trim() ?? '')).not.toBe('');
    expect(await t.locator('th').count()).toBeGreaterThan(0);
  }
  // Verification steps are a list whose status is text, not colour alone.
  for (const step of await page.locator('[data-step]').all()) {
    expect((await step.innerText()).trim().length).toBeGreaterThan(0);
  }
  // One concise status announcement, not the whole result block.
  await expect(page.getByRole('status').filter({ hasText: 'Verification finished with no failed checks.' })).toBeAttached();
  expect(await page.locator('[aria-live]').filter({ hasText: 'Reproduced independently' }).count()).toBe(0);
});

test('the bundle file control is reachable by keyboard and shows a focus ring', async ({ page }) => {
  await page.goto('/replay/synthetic-sample');
  const input = page.locator('input[type=file]').first();
  for (let i = 0; i < 40 && !(await input.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  expect(await input.evaluate((el) => el === document.activeElement), 'file input reachable with Tab').toBe(true);
  // The input itself is visually hidden, so its styled label must show the focus indicator.
  // (Keyboard focus, so :focus-visible applies.)
  const ring = await input.evaluate((el) => {
    const label = el.closest('label') ?? el;
    const s = getComputedStyle(label);
    return { outline: s.outlineStyle, shadow: s.boxShadow };
  });
  expect(ring.outline !== 'none' || ring.shadow !== 'none', JSON.stringify(ring)).toBe(true);
});

test('skip link is first in the tab order and moves focus to the main content', async ({ page }) => {
  await page.goto('/programs');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); // the lazy page has rendered
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  const target = await page.evaluate(() => {
    const el = document.activeElement;
    return el !== null && (el.id === 'main' || el.closest('#main') !== null);
  });
  expect(target).toBe(true);
});

test('every interactive element on the home page is reachable with Tab and has a visible focus indicator', async ({ page }) => {
  await page.goto('/');
  const seen = new Set<string>();
  const missing: string[] = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return { key: `${el.tagName}:${el.textContent.trim().slice(0, 40)}:${el.getAttribute('href') ?? ''}`, ring: s.outlineStyle !== 'none' || s.boxShadow !== 'none' };
    });
    if (!info || seen.has(info.key)) break;
    seen.add(info.key);
    if (!info.ring) missing.push(info.key);
  }
  expect(seen.size).toBeGreaterThan(3);
  expect(missing).toEqual([]);
});

test('mobile menu is operable by keyboard: Enter opens it, Escape closes it and returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await expect(menu).toBeFocused();
});

for (const path of ['/', '/programs', '/demo', '/status', '/replay/p1', '/fairness/p1', '/audit/p1']) {
  test(`reflow: ${path} at 320 CSS px (400% zoom) has no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('text spacing (WCAG 1.4.12) does not clip or overlap the home page', async ({ page }) => {
  await page.goto('/');
  await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('reduced motion: no animations or transitions run when the user asks for less motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const moving = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('*')]
      .filter((el) => {
        const s = getComputedStyle(el);
        const dur = (v: string) => v.split(',').some((x) => parseFloat(x) > 0.01);
        return (s.animationName !== 'none' && dur(s.animationDuration)) || dur(s.transitionDuration);
      })
      .map((el) => el.className || el.tagName)
      .slice(0, 5),
  );
  expect(moving).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.style.scrollBehavior || getComputedStyle(document.documentElement).scrollBehavior)).not.toBe('smooth');
});

// Dark theme (added with the redesign): contrast and every other rule again, on the stored-theme path.
for (const path of ['/', '/programs', '/status', '/demo', '/replay/p1', '/fairness/p1', '/audit/p1']) {
  test(`axe, dark theme: ${path} has no WCAG 2.1 AA violations`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('even-odds-theme', 'dark');
    });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(await axeViolations(page)).toEqual([]);
  });
}
