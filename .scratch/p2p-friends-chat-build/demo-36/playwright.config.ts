import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from '../../../playwright.config';

// Records the videos of ticket 36 (not part of the suite): pnpm exec playwright test -c .scratch/p2p-friends-chat-build/demo-36
export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: './results',
  retries: 0,
  projects: base.projects!.slice(0, 1),
  webServer: { ...(base.webServer as object), cwd: fileURLToPath(new URL('../../..', import.meta.url)) } as typeof base.webServer,
});
