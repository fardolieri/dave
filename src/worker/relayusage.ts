import type { CredentialRequest } from '../core/turn';
import { RELAY_FREE_BYTES, freePlanRequest, monthSoFar, parseFreePlan, parseRelayBytes, relayUsageRequest, type FreePlanToday, type RelayUsage } from '../core/relayusage';

/**
 * `/relay-usage`: how much the TURN relay sent this month, and what the account used today of the free plan's limits
 * (core/relayusage.ts), for the About dialog. Asked of Cloudflare's GraphQL API with RELAY_USAGE_API_TOKEN, a token that
 * can only read the account's analytics, never the deploy token. Without it (local dev, tests, a Worker the secret has not
 * reached) the answer is 204, and the dialog leaves the figures out; a failure is a 200 with `error`, which the dialog
 * shows as not known. Neither is an error status: the browser would log one in the console, which fails an e2e test, and
 * says nothing a friend could act on.
 */
export const RELAY_USAGE_PATH = '/relay-usage';

/** How long an answer is kept, in this isolate: the About dialog of every friend asks the API at most this often per isolate. */
const KEEP_MS = 10 * 60_000;
/** How long a failure is kept, so a broken token or an API outage is not asked again on every open. */
const KEEP_FAILURE_MS = 60_000;
/** A call older than its 5 s timeout and some is not waited for: should its request have been cancelled, it never ends. */
const ASKING_MS = 6000;

/**
 * One figure asked of Cloudflare and kept, in this isolate (the Cache API does nothing on workers.dev, where the live site
 * is). Each its own: the relay's decides what keeps off the relay, and must not go with the free plan's, which a token
 * without Durable Object analytics may be refused. Requests that come while it is being asked wait for that answer,
 * rather than each asking and the slowest having the last word. Asked again KEEP_MS after an answer, KEEP_FAILURE_MS
 * after a failure, and at once in a new `period` (a month for the relay's, a day for the free plan's).
 */
function keptFigure<T>(period: (now: number) => string, ask: (token: string, account: string, now: number) => Promise<T | null>) {
  let kept: { at: number; period: string; value: T | null } | null = null;
  let asking: { since: number; done: Promise<void> } | null = null;
  return {
    async get(token: string, account: string, now: number): Promise<T | null> {
      const stale = !kept || now - kept.at > (kept.value === null ? KEEP_FAILURE_MS : KEEP_MS) || kept.period !== period(now);
      if (stale) {
        if (!asking || Date.now() - asking.since > ASKING_MS) {
          const mine = {
            since: Date.now(),
            done: ask(token, account, now).catch(() => null).then((value) => { kept = { at: now, period: period(now), value }; })
              .finally(() => { if (asking === mine) asking = null; }),
          };
          asking = mine;
        }
        await asking.done;
      }
      return kept?.value ?? null;
    },
    forget(): void { kept = null; asking = null; },
  };
}

const relay = keptFigure((now) => monthSoFar(now).from, (token, account, now) => askFor(relayUsageRequest(account, token, now), parseRelayBytes));
const freePlan = keptFigure((now) => monthSoFar(now).to, (token, account, now) => askFor(freePlanRequest(account, token, now), (json): FreePlanToday | null => parseFreePlan(json, monthSoFar(now).to)));

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function relayUsage(env: Env, now = Date.now()): Promise<Response> {
  const token = env.RELAY_USAGE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  try {
    const [bytes, today] = await Promise.all([relay.get(token, account, now), freePlan.get(token, account, now)]);
    if (bytes === null) return json({ error: 'unavailable' });
    const usage: RelayUsage = { bytes, limit: RELAY_FREE_BYTES, since: monthSoFar(now).from, asOf: now, ...(today ? { today } : {}) };
    return json(usage);
  } catch {
    return json({ error: 'unavailable' });
  }
}

/** One question to Cloudflare's API, its answer read by `parse`; null for any failure. */
async function askFor<T>(req: CredentialRequest, parse: (json: unknown) => T | null): Promise<T | null> {
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(5000) });
    return res.ok ? parse(await res.json()) : null;
  } catch {
    return null;
  }
}

/** Tests only: forget what is kept. */
export function forgetRelayUsage(): void {
  relay.forget();
  freePlan.forget();
}
