import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke tests. The dev server is started with deliberately empty
 * public config so the "configuration missing" path is exercised without
 * touching Appwrite; connected-state checks live in the integration suite.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5179', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --port 5179 --strictPort --mode e2e',
    url: 'http://localhost:5179',
    reuseExistingServer: false,
    env: {
      VITE_APPWRITE_ENDPOINT: '',
      VITE_APPWRITE_PROJECT_ID: '',
      VITE_APPWRITE_DATABASE_ID: '',
    },
  },
});
