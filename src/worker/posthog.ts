/**
 * PostHog behind our own origin. Tracker blockers drop every request to posthog.com, even in a browser whose friend said
 * yes to helping find bugs (ticket 32): so the client sends to `/diag/…` here, and this passes it on. Only what the
 * opted-in SDK or a problem report sends ever comes through; the friend's yes or no is still the client's to keep.
 *
 * The SDK, given a host of its own, asks it for everything: events and recordings, and also its lazy-loaded scripts
 * (`/static/…`, the session recorder among them) and the project's remote config (`/array/…`), which PostHog serves
 * from a separate assets host.
 */
export const PREFIX = '/diag';

/** Where a request to `/diag/<path>` goes, or null for a path outside the prefix. `host` is the project's ingest host. */
export function upstream(url: URL, host: string): string | null {
  if (!url.pathname.startsWith(`${PREFIX}/`)) return null;
  const path = url.pathname.slice(PREFIX.length);
  const assets = /^\/(static|array)\//.test(path);
  // https://eu.i.posthog.com serves its assets from https://eu-assets.i.posthog.com.
  const base = assets ? host.replace(/^https:\/\/([a-z]+)\.i\.posthog\.com$/, 'https://$1-assets.i.posthog.com') : host;
  return `${base}${path}${url.search}`;
}

export async function forward(request: Request, env: Env): Promise<Response> {
  const host = env.POSTHOG_HOST;
  const target = host ? upstream(new URL(request.url), host) : null;
  if (!target) return new Response('not found', { status: 404 });
  const headers = new Headers(request.headers);
  headers.delete('cookie'); // ours, not PostHog's
  // PostHog places an event by the sender's address, as it did when the browser sent it directly.
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-forwarded-for', ip);
  return fetch(target, { method: request.method, headers, body: request.body, redirect: 'manual' });
}
