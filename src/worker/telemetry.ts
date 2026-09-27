import type { Outcome } from '../core/room';

/**
 * A frame the Room refused (ticket 30), logged from the server: the sender's own tab may block PostHog or be on a line
 * too flaky to deliver its events, which is exactly when frames go wrong. One line in the Worker logs always; one
 * `server_frame_rejected` event on the sender's person when PostHog is configured (prod and nightly, not tests) and
 * the sender opted in to PostHog (ticket 32). The frame itself is never sent anywhere, only its type, length and why it was refused.
 */
export function logRejected(env: Env, ctx: DurableObjectState, rejected: NonNullable<Outcome['rejected']>): void {
  console.warn('frame rejected', JSON.stringify({ ref: rejected.ref ?? null, reason: rejected.reason, length: rejected.length }));
  const key = env.POSTHOG_KEY;
  const host = env.POSTHOG_HOST;
  if (!key || !host || !rejected.telemetry) return;
  const body = {
    api_key: key,
    event: 'server_frame_rejected',
    distinct_id: rejected.from,
    properties: { ref: rejected.ref ?? null, reason: rejected.reason, length: rejected.length, $lib: 'dave-worker' },
    timestamp: new Date().toISOString(),
  };
  ctx.waitUntil(
    fetch(`${host}/i/v0/e/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) console.warn('posthog capture failed', r.status); })
      .catch((e) => console.warn('posthog capture failed', e)),
  );
}
