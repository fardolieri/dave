import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

// Tests run inside workerd against the real wrangler config, so the Room Durable
// Object and the hibernation API behave as in production.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  plugins: [
    // No PostHog from the Room under test: the suite rejects frames on purpose.
    cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: { POSTHOG_KEY: '', POSTHOG_HOST: '' } } }),
  ],
});
