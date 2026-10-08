import { defineConfig, devices } from '@playwright/test';
import { launchOptions, originFor } from './e2e/browsers';
import type { Film } from './e2e/fixtures';
import suite from './playwright.config';

/**
 * Video receipts (.github/workflows/receipts.yml): the tests tagged `@receipt`, anywhere in e2e/, filmed at a phone and at
 * a desktop viewport. The tour in e2e/receipts/ is one; the normal suite skips that folder. Same local build as the suite.
 *
 *   pnpm exec playwright test -c playwright.receipts.config.ts     videos in receipts-out/<phone|desktop>/
 *
 * Chromium only: a receipt shows what changed on screen, the suite covers the engines.
 */
const film = (name: string, viewport: { width: number; height: number }) => ({
  name,
  use: { ...devices['Desktop Chrome'], baseURL: originFor('chromium'), launchOptions: launchOptions('chromium'), film: { viewport, dir: `receipts-out/${name}` } satisfies Film },
});

export default defineConfig<{ film: Film }>({
  ...suite,
  testIgnore: [],
  grep: /@receipt/,
  // A failed receipt is still published with its video; a retry would only film it twice.
  retries: 0,
  reporter: 'list',
  outputDir: 'receipts-results',
  projects: [film('phone', { width: 390, height: 780 }), film('desktop', { width: 1280, height: 800 })],
});
