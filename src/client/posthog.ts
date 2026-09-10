/**
 * PostHog analytics singleton. Import `posthog` from here so the SDK is initialised exactly once.
 *
 * The project key is a public client token (safe in the repo, see .env); without it, in production,
 * every capture is a no-op. This is a private friends room: session replay is on for debugging but
 * masks all text and inputs, and no event ever carries message text or names.
 */
import posthogJs from 'posthog-js';
import { local } from './storage';

/**
 * A browser the driver (scripts/drive.mjs) seeded with `dave.test = true`. Its events carry
 * `is_test_account` and its person is marked `$internal_or_test_user`, the property the project's
 * "Internal / Test users" cohort keys on, so PostHog's test-account filter drops it from insights.
 */
export const isTestAccount: boolean = local.get('test') === 'true';

const key = import.meta.env['VITE_POSTHOG_KEY'] as string | undefined;
const host = import.meta.env['VITE_POSTHOG_HOST'] as string | undefined;

if (!key || !host) {
  if (import.meta.env.DEV) console.warn('PostHog is not configured (VITE_POSTHOG_KEY / VITE_POSTHOG_HOST); events are dropped.');
} else {
  posthogJs.init(key, {
    api_host: host,
    defaults: '2026-05-30',
    capture_exceptions: true,
    person_profiles: 'identified_only',
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*', // chat, names, fingerprints: never in a recording
    },
  });
  if (isTestAccount) posthogJs.register({ is_test_account: true });
}

export default posthogJs;
