import { expect, test } from '@playwright/test';

test('missing configuration shows a helpful error, not a blank page', async ({ page }) => {
  await page.goto('/status');
  await expect(page.getByText('Configuration missing: no connection attempted')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('VITE_APPWRITE_ENDPOINT');
});

test('keyboard users can skip to content', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
});
