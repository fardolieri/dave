// How much the TURN relay has sent this month, against what Cloudflare relays for free (the About dialog). Cloudflare's
// GraphQL Analytics API knows it; the Worker asks with a token that may only read analytics, and the client shows it.
import type { CredentialRequest } from './turn';

/**
 * Cloudflare Realtime's free allowance: "The first 1,000 GB each month is free", counted on what Cloudflare sends (egress),
 * shared between TURN and the SFU, $0.05 per GB past it (developers.cloudflare.com/realtime/pricing, 2026-11-02).
 */
export const RELAY_FREE_BYTES = 1_000_000_000_000;

/**
 * From this share of the free allowance on, screen shares and files keep off the relay for the rest of the month: a
 * share stops going to a viewer whose connection runs through it, and a file link gets no TURN server, so it goes direct
 * or not at all. Voice still goes through it.
 */
export const RELAY_SAVE_FROM = 0.8;

/** Whether `u`, read at `now`, says to keep shares and files off the relay. Last month's figure says nothing about this one. */
export function savesRelay(u: RelayUsage | null, now: number): boolean {
  return u !== null && u.since === monthSoFar(now).from && u.bytes >= u.limit * RELAY_SAVE_FROM;
}

/**
 * What the Worker's `/relay-usage` answers: bytes sent since `since` (the 1st of this month, UTC, `YYYY-MM-DD`), as of
 * `asOf`. `today`: what the whole account used of the free plan's daily limits on that day (UTC), every room and preview
 * together, when Cloudflare said.
 */
export type RelayUsage = { bytes: number; limit: number; since: string; asOf: number; today?: FreePlanToday };

/** What the account used today (UTC) of what the Workers Free plan allows (`FREE_PLAN`), and stored in all. */
export type FreePlanToday = {
  day: string;
  /**
   * Requests to Durable Objects as billed: every socket opened to a room, every call to the history, every alarm, and a
   * twentieth for every frame a hibernating room is woken for (Cloudflare bills those 20 to 1).
   */
  objectRequests: number;
  /** Requests to the Worker: the upgrades, the About dialog's asks, what goes to PostHog. Static files are free. */
  workerRequests: number;
  rowsWritten: number;
  rowsRead: number;
  /** Durable Object time, GB-s: 128 MB for each second a room is awake (asleep between frames, it costs nothing). */
  compute: number;
  /** Bytes stored by every Durable Object, of every Worker, the previews' included: a total, not a day's. */
  stored: number;
};

/**
 * The Workers Free plan's limits (developers.cloudflare.com/workers/platform/pricing and durable-objects/platform/pricing,
 * read 2026-11-05): a day's, reset at 00:00 UTC, but `stored`, a total. Past any, what it counts fails until the reset:
 * every room, not only what went past.
 */
export const FREE_PLAN: Record<keyof Omit<FreePlanToday, 'day'>, number> = {
  objectRequests: 100_000,
  workerRequests: 100_000,
  rowsWritten: 100_000,
  rowsRead: 5_000_000,
  compute: 13_000,
  stored: 5_000_000_000,
};

/** The first day of `now`'s month and `now`'s day, UTC, as the API's `Date`s. A month never spans more than the 31 days it keeps. */
export function monthSoFar(now: number): { from: string; to: string } {
  const to = new Date(now).toISOString().slice(0, 10);
  return { from: `${to.slice(0, 8)}01`, to };
}

// The whole account, every TURN key and the SFU: the allowance is the account's, and previews relay on it too.
const QUERY = `query($account: String!, $from: Date!, $to: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    turn: callsTurnUsageAdaptiveGroups(limit: 1, filter: { date_geq: $from, date_leq: $to }) { sum { egressBytes } }
    sfu: callsUsageAdaptiveGroups(limit: 1, filter: { date_geq: $from, date_leq: $to }) { sum { egressBytes } }
  } }
}`;

/**
 * Today's use of the free plan, the whole account's (UTC day). Asked apart from the relay's: should Cloudflare refuse a
 * part of it, the relay's figure, which decides what keeps off the relay, still comes. `requests` by `type`: a frame a
 * hibernating room is woken for (`hibernation`, as the API names it: alarm, http, jsrpc are the others) is billed as a
 * twentieth of a request (`HIBERNATION_SHARE`). `duration`
 * is GB-s (128 MB for each second a room is awake). Stored bytes by namespace: the largest of the day of each, added up.
 */
const FREE_PLAN_QUERY = `query($account: String!, $day: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    objects: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { date_geq: $day, date_leq: $day }) { sum { requests } dimensions { type } }
    workers: workersInvocationsAdaptive(limit: 1, filter: { date_geq: $day, date_leq: $day }) { sum { requests } }
    periodic: durableObjectsPeriodicGroups(limit: 1, filter: { date_geq: $day, date_leq: $day }) { sum { rowsRead rowsWritten duration } }
    stored: durableObjectsSqlStorageGroups(limit: 1000, filter: { date_geq: $day, date_leq: $day }) { max { storedBytes } dimensions { namespaceId } }
  } }
}`;

const graphql = (apiToken: string, query: string, variables: Record<string, string>): CredentialRequest => ({
  url: 'https://api.cloudflare.com/client/v4/graphql',
  method: 'POST',
  headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ query, variables }),
});

export function relayUsageRequest(accountId: string, apiToken: string, now: number): CredentialRequest {
  const { from, to } = monthSoFar(now);
  return graphql(apiToken, QUERY, { account: accountId, from, to });
}

export function freePlanRequest(accountId: string, apiToken: string, now: number): CredentialRequest {
  return graphql(apiToken, FREE_PLAN_QUERY, { account: accountId, day: monthSoFar(now).to });
}

/** A frame that wakes a hibernating room is billed as this much of a request (Durable Objects pricing, 20:1). */
const HIBERNATION_SHARE = 1 / 20;

/** The account's groups in an API answer; null for errors or another shape. */
function accountOf(json: unknown): Record<string, unknown> | null {
  const j = json as { data?: { viewer?: { accounts?: unknown[] } }; errors?: unknown[] } | null;
  if (j?.errors?.length) return null;
  return (j?.data?.viewer?.accounts?.[0] as Record<string, unknown> | undefined) ?? null;
}

/** A group's rows added up by `take`, each a finite number of at least 0; null for a group missing or a row that is not. */
function sumGroup(account: Record<string, unknown>, group: string, take: (row: Record<string, unknown>) => unknown): number | null {
  const rows = account[group];
  if (!Array.isArray(rows)) return null;
  let total = 0;
  for (const row of rows) {
    const n = take((row ?? {}) as Record<string, unknown>);
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    total += n;
  }
  return total;
}
const sumOf = (k: string) => (row: Record<string, unknown>) => (row.sum as Record<string, unknown> | undefined)?.[k];

/** The bytes sent in the API's answer, TURN and SFU together; null for errors or an answer of another shape. No traffic is no rows: 0. */
export function parseRelayBytes(json: unknown): number | null {
  const account = accountOf(json);
  if (!account) return null;
  const turn = sumGroup(account, 'turn', sumOf('egressBytes'));
  const sfu = sumGroup(account, 'sfu', sumOf('egressBytes'));
  return turn === null || sfu === null ? null : turn + sfu;
}

/**
 * Today's use of the free plan in the API's answer; null for an answer without it. No rows in a group: nothing used.
 * Stored bytes are the largest of the day per namespace, added up: one Worker's rooms, another's, a preview's.
 */
export function parseFreePlan(json: unknown, day: string): FreePlanToday | null {
  const a = accountOf(json);
  if (!a) return null;
  const out = {
    objectRequests: sumGroup(a, 'objects', (r) => {
      const n = sumOf('requests')(r);
      return typeof n === 'number' && (r.dimensions as { type?: unknown } | undefined)?.type === 'hibernation' ? n * HIBERNATION_SHARE : n;
    }),
    workerRequests: sumGroup(a, 'workers', sumOf('requests')),
    rowsWritten: sumGroup(a, 'periodic', sumOf('rowsWritten')),
    rowsRead: sumGroup(a, 'periodic', sumOf('rowsRead')),
    compute: sumGroup(a, 'periodic', sumOf('duration')),
    stored: sumGroup(a, 'stored', (r) => (r.max as Record<string, unknown> | undefined)?.storedBytes),
  };
  if (Object.values(out).some((v) => v === null)) return null;
  return { day, ...(out as Omit<FreePlanToday, 'day'>) };
}

/** The Worker's answer as the client reads it, or null. */
export function parseRelayUsage(json: unknown): RelayUsage | null {
  const u = json as Partial<RelayUsage> | null;
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!u || !num(u.bytes) || !num(u.limit) || u.limit === 0 || !num(u.asOf) || typeof u.since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(u.since)) return null;
  const t = u.today as Partial<FreePlanToday> | undefined;
  const keys = Object.keys(FREE_PLAN) as Array<keyof typeof FREE_PLAN>;
  // Its own fields only, copied one by one, as the relay's are.
  const today = t && typeof t.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.day) && keys.every((k) => num(t[k]))
    ? { today: { day: t.day, ...Object.fromEntries(keys.map((k) => [k, t[k]])) } as FreePlanToday } : {};
  return { bytes: u.bytes, limit: u.limit, since: u.since, asOf: u.asOf, ...today };
}

/** Bytes as Cloudflare bills them, in powers of 1000: "830 MB", "14.1 GB", "1 TB". */
export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${i === 0 || n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} ${units[i]}`;
}

/** A share in percent: to a tenth below 10 %, then whole; "<0.1" for a little, "0" for none. */
export function formatPercent(part: number, of: number): string {
  const pct = (part / of) * 100;
  return pct > 0 && pct < 0.1 ? '<0.1' : pct < 10 ? (Math.round(pct * 10) / 10).toString() : Math.round(pct).toString();
}

/** A count as people read one: "940", "62,736", "1.2 M". */
export function formatCount(n: number): string {
  if (n < 1_000_000) return Math.round(n).toLocaleString('en-US');
  const m = n / 1_000_000;
  return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : Math.round(m * 10) / 10} M`;
}

/** How full a meter is, as the About dialog says it: below half, past half, past 80 %. */
export type Fill = 'ok' | 'warn' | 'bad';
export const fillOf = (part: number, of: number): Fill => (part >= of * 0.8 ? 'bad' : part >= of * 0.5 ? 'warn' : 'ok');

/**
 * How far `now` is through the period a limit resets after, 0 to 1: the day, or the month from the 1st, UTC, as
 * Cloudflare counts both. A limit used at an even pace stands at this share of itself now; one past it runs out before
 * the reset if it goes on as it went (the About dialog's pace line).
 */
export function elapsedOf(period: 'day' | 'month', now: number): number {
  const d = new Date(now);
  const [y, m] = [d.getUTCFullYear(), d.getUTCMonth()];
  const from = period === 'day' ? Date.UTC(y, m, d.getUTCDate()) : Date.UTC(y, m, 1);
  const to = period === 'day' ? from + 24 * 3600_000 : Date.UTC(y, m + 1, 1);
  return (now - from) / (to - from);
}

/** "14.1 GB of 1 TB (1.4%)": bytes of a limit, as the server's history says how full it is (core/kept.ts). */
export const formatShare = (bytes: number, of: number): string => `${formatBytes(bytes)} of ${formatBytes(of)} (${formatPercent(bytes, of)}%)`;
