import { RELAY_FREE_BYTES, monthSoFar, parseRelayBytes, relayUsageRequest, type RelayUsage } from '../core/relayusage';

/**
 * `/relay-usage`: how much the TURN relay sent this month (core/relayusage.ts), for the About dialog. Asked of Cloudflare's
 * GraphQL API with RELAY_USAGE_API_TOKEN, a token that can only read the account's analytics, never the deploy token.
 * Without it (local dev, tests, a Worker the secret has not reached) the answer is 204, and the dialog leaves the line out;
 * a failure is a 200 with `error`, which the dialog shows as not known. Neither is an error status: the browser would log
 * one in the console, which fails an e2e test, and says nothing a friend could act on.
 */
export const RELAY_USAGE_PATH = '/relay-usage';

/** How long an answer is kept, in this isolate: the About dialog of every friend asks the API at most this often per isolate. */
const KEEP_MS = 10 * 60_000;
/** How long a failure is kept, so a broken token or an API outage is not asked again on every open. */
const KEEP_FAILURE_MS = 60_000;

// The Cache API does nothing on workers.dev, where the live site is: so in memory, per isolate. Requests that come
// while Cloudflare is being asked wait for that answer, rather than each asking and the slowest having the last word.
let kept: { at: number; usage: RelayUsage | null } | null = null;
let asking: { since: number; done: Promise<void> } | null = null;
/** A call older than its 5 s timeout and some is not waited for: should its request have been cancelled, it never ends. */
const ASKING_MS = 6000;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function relayUsage(env: Env, now = Date.now()): Promise<Response> {
  const token = env.RELAY_USAGE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  // A new month is asked about at once, not after what is kept from the last one runs out.
  const stale = !kept || now - kept.at > (kept.usage ? KEEP_MS : KEEP_FAILURE_MS) || (kept.usage !== null && kept.usage.since !== monthSoFar(now).from);
  if (stale) {
    if (!asking || Date.now() - asking.since > ASKING_MS) {
      const mine = { since: Date.now(), done: ask(token, account, now).finally(() => { if (asking === mine) asking = null; }) };
      asking = mine;
    }
    await asking.done;
  }
  return json(kept?.usage ?? { error: 'unavailable' });
}

async function ask(token: string, account: string, now: number): Promise<void> {
  let usage: RelayUsage | null = null;
  try {
    const req = relayUsageRequest(account, token, now);
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(5000) });
    const bytes = res.ok ? parseRelayBytes(await res.json()) : null;
    if (bytes !== null) usage = { bytes, limit: RELAY_FREE_BYTES, since: monthSoFar(now).from, asOf: now };
  } catch {
    // usage stays unknown
  }
  kept = { at: now, usage };
}

/** Tests only: forget the kept answer. */
export function forgetRelayUsage(): void {
  kept = null;
  asking = null;
}
