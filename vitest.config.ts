import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

// Tests run inside workerd against the real wrangler config, so the Room Durable
// Object and the hibernation API behave as in production.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  plugins: [
    // No PostHog from the Room under test: the suite rejects frames on purpose. No relay usage token either, should a
    // .dev.vars have one: the tests give theirs where they need it.
    cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: { POSTHOG_KEY: '', POSTHOG_HOST: '', RELAY_USAGE_API_TOKEN: '' } } }),
  ],
});
