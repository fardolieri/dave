import type { Outcome } from '../core/room';

/**
 * A frame the Room refused (ticket 30), logged from the server: the sender's own tab may block PostHog or be on a line
 * too flaky to deliver its events, which is exactly when frames go wrong. One line in the Worker logs always; one
 * `server_frame_rejected` event on the sender's person when PostHog is configured (prod and nightly, not tests) and
 * the sender opted in to PostHog (ticket 32). It says which copy of the app refused it (`build_target`, as on the client's
 * events; the Worker does not know its commit). The frame itself is never sent anywhere, only its type, length and why it was refused.
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
    properties: { ref: rejected.ref ?? null, reason: rejected.reason, length: rejected.length, build_target: env.BUILD_TARGET, $lib: 'dave-worker' },
    timestamp: new Date().toISOString(),
  };
  ctx.waitUntil(
    fetch(`${host}/i/v0/e/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) console.warn('posthog capture failed', r.status); })
      .catch((e) => console.warn('posthog capture failed', e)),
  );
}

/**
 * An upgrade that threw, in the Worker or in the Room, answered with 500 (ticket 55: seen against previews and nightly,
 * with nothing to say why). One line in the Worker logs always; one `server_upgrade_failed` event when PostHog is
 * configured, under the Worker's own id, since nobody is known before the handshake. Cloudflare marks some of its errors
 * `retryable` or `overloaded` (a Durable Object reset by a deploy, one too busy); they are sent along. No room id, no address.
 */
export function logUpgradeFailed(env: Env, ctx: ExecutionContext, error: unknown, attempt = 1): void {
  const e = error as { name?: unknown; message?: unknown; retryable?: unknown; overloaded?: unknown } | null;
  const properties = {
    name: typeof e?.name === 'string' ? e.name : null,
    message: typeof e?.message === 'string' ? e.message.slice(0, 300) : String(error).slice(0, 300),
    retryable: e?.retryable === true,
    overloaded: e?.overloaded === true,
    // 1: the Room is asked once more; 2: that failed too, and the browser got the 500.
    attempt,
  };
  console.error('upgrade failed', JSON.stringify(properties));
  const key = env.POSTHOG_KEY;
  const host = env.POSTHOG_HOST;
  if (!key || !host) return;
  const body = {
    api_key: key,
    event: 'server_upgrade_failed',
    distinct_id: `dave-worker-${env.BUILD_TARGET}`,
    properties: { ...properties, build_target: env.BUILD_TARGET, $lib: 'dave-worker', $process_person_profile: false },
    timestamp: new Date().toISOString(),
  };
  ctx.waitUntil(
    fetch(`${host}/i/v0/e/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) console.warn('posthog capture failed', r.status); })
      .catch((e) => console.warn('posthog capture failed', e)),
  );
}
