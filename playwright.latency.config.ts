import { defineConfig } from '@playwright/test';
import suite from './playwright.config';

/**
 * How long a friend's voice takes from one browser's microphone to another's speaker (e2e/latency/, ticket 96), on real
 * PulseAudio devices that scripts/latency/rig.sh sets up: one test after another, nothing else running. A local build.
 *
 *   scripts/latency/rig.sh run
 */
export default defineConfig({
  ...suite,
  testDir: 'e2e/latency',
  testIgnore: [],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  failOnFlakyTests: false,
  timeout: 600_000,
  reporter: 'list',
  outputDir: 'latency-results/playwright',
  use: { ...suite.use, trace: 'off', screenshot: 'off' },
  projects: [suite.projects![0]!],
});
