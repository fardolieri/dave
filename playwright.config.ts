import { defineConfig, devices } from '@playwright/test';
import { launchOptions, LOCAL_PORT, originFor, target } from './e2e/browsers';

/**
 * The browser test suite (e2e/). Real browsers, the real Worker and Room, real WebRTC between the browsers.
 *
 * One switch picks what it runs against:
 *   pnpm e2e            a local build: the app built with the inspection hooks on (VITE_E2E=1) and the `e2e` Wrangler
 *                       environment (no upgrade limit), served by `vite preview` in workerd
 *   pnpm e2e:nightly    the deployed nightly Worker, which master builds with the same hooks
 *   E2E_URL=<url>       any other deployed copy; tests that need the hooks skip themselves where they are missing
 *
 * E2E_FIREFOX=1 adds the Firefox project (always on in CI). Slow machine: E2E_SLOW=4 stretches every timeout.
 */
const slow = Number(process.env['E2E_SLOW']) || 1;
const ci = !!process.env['CI'];

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000 * slow,
  expect: { timeout: 20_000 * slow },
  fullyParallel: false,
  // A deployed Worker limits socket upgrades per IP (see wrangler.jsonc): one test at a time there.
  workers: Number(process.env['E2E_WORKERS']) || (ci && !target ? 2 : 1),
  retries: ci ? 1 : 0,
  forbidOnly: ci,
  reporter: ci ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : 'list',
  outputDir: 'e2e-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000 * slow,
    navigationTimeout: 30_000 * slow,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL: originFor('chromium'), launchOptions: launchOptions('chromium') } },
    ...(process.env['E2E_FIREFOX'] || ci ? [{ name: 'firefox', use: { ...devices['Desktop Firefox'], baseURL: originFor('firefox'), launchOptions: launchOptions('firefox') } }] : []),
  ],
  webServer: target
    ? undefined
    : {
        // The environment is picked at build time only; the built config is already flattened, so preview must not see it.
        // On every interface: Firefox opens it on the network address (see originFor in e2e/browsers.ts).
        command: `CLOUDFLARE_ENV=e2e VITE_E2E=1 pnpm build && pnpm exec vite preview --host 0.0.0.0 --port ${LOCAL_PORT} --strictPort`,
        url: `http://localhost:${LOCAL_PORT}`,
        reuseExistingServer: !ci,
        timeout: 600_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
