import { defineConfig, devices } from '@playwright/test';
import { launchOptions, originFor } from './e2e/browsers';
import suite from './playwright.config';

/**
 * The nightly chaos soak (e2e/soak/, .github/workflows/soak.yml): one long test, so one worker and no retry, and none of
 * the suite's automatic traces, which would hold every step of a long run. The soak traces the shortest failing list
 * itself. The test opens its Firefox friends in a browser of its own; the project is Chromium. Same target switch as the
 * suite: a local build, or E2E_URL=nightly.
 *
 *   E2E_URL=nightly SOAK_MINUTES=15 pnpm exec playwright test -c playwright.soak.config.ts
 */
export default defineConfig({
  ...suite,
  testDir: 'e2e/soak',
  testIgnore: [],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  failOnFlakyTests: false,
  reporter: 'list',
  outputDir: 'soak-results',
  use: { ...suite.use, trace: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL: originFor('chromium'), launchOptions: launchOptions('chromium') } }],
});
