import { expect, test } from '@playwright/test';

const ROUTES = [
  '/',
  '/programs',
  '/programs/p1',
  '/family',
  '/family/children',
  '/applications/new/p1',
  '/applications/a1',
  '/organiser',
  '/organiser/programs/p1',
  '/audit/p1',
  '/replay/p1',
  '/fairness/p1',
  '/status',
  '/demo',
  '/nope',
];

for (const viewport of [
  { name: 'mobile', width: 375, height: 740 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const path of ROUTES) {
      test(`${path} renders a page heading without errors or horizontal scroll`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      });
    }
  });
}

test('keyboard focus is visibly outlined', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab'); // skip link
  await page.keyboard.press('Tab'); // brand link
  const outline = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? getComputedStyle(el).outlineStyle : 'none';
  });
  expect(outline).not.toBe('none');
});

test('mobile menu opens and links are reachable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeHidden();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(nav).toBeVisible();
  await nav.getByRole('link', { name: 'Programs' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Programs' })).toBeVisible();
  await expect(nav).toBeHidden();
});
