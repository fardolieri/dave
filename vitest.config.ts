import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

// Tests run inside workerd against the real wrangler config, so the Room Durable
// Object and the hibernation API behave as in production.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
