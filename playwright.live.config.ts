import { defineConfig, devices } from '@playwright/test';

/**
 * Live browser walkthrough of the judge demo (npm run test:e2e:live).
 * Unlike tests/e2e, this uses the REAL Appwrite project from .env.local and
 * the deployed Functions: it starts a guest session, clicks through the
 * whole demo script and replays the draw. Each run creates one sandbox and
 * one guest user, both removed afterwards with the server key.
 */
export default defineConfig({
  testDir: 'tests/e2e-live',
  reporter: 'list',
  timeout: 420_000,
  expect: { timeout: 60_000 },
  use: { baseURL: 'http://localhost:5180', trace: 'retain-on-failure', viewport: { width: 1280, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
  webServer: {
    command: 'npx vite --port 5180 --strictPort',
    url: 'http://localhost:5180',
    reuseExistingServer: false,
  },
});
