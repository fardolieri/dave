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
 * together, and the live site's part of it, when Cloudflare said.
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
  /** The live site's own part of the daily figures (LIVE_SCRIPT, LIVE_NAMESPACES); the previews used the rest. */
  live?: DailyFigures;
};

/** What a day counts against the free plan's daily limits: the account's, or one side's of it (`Side`). */
export type DailyFigures = Pick<FreePlanToday, (typeof DAILY_LIMITS)[number]>;

/**
 * Who a daily limit is shared between: the live site, and the pull requests' previews (preview.yml), all of them
 * together. Each may use SIDE_SHARE of every daily limit (`usedUp`): the previews running the browser suite cannot use up
 * a day the friends need, and the friends cannot use up the day a fix needs to pass its preview. On 2026-11-17 the
 * previews' runs used the account's 100,000 requests to Durable Objects by 20:44 UTC, and every room of the live site
 * failed until midnight with theirs (ticket 89). Not half each: the figures are minutes behind, a side goes on past its
 * share until its Worker hears of it, and rooms already open go on after. The tenth between keeps each side its half.
 */
export type Side = 'live' | 'preview';
export const SIDE_SHARE = 0.45;

/**
 * The live site's Worker, and its Durable Object namespaces (Room, Store), as Cloudflare's analytics name them: what is
 * not theirs is the previews'. A namespace's id stays as long as its Worker does; were `dave` ever deleted and deployed
 * anew, these would be its new ones (`GET /accounts/<id>/workers/durable_objects/namespaces`).
 */
export const LIVE_SCRIPT = 'dave';
export const LIVE_NAMESPACES: readonly string[] = ['4f5ba8a3f4464117a59e7a3a540651cd', '2cac5b332d6e401a986e554fa38f3875'];

/**
 * The Workers Free plan's limits (developers.cloudflare.com/workers/platform/pricing and durable-objects/platform/pricing,
 * read 2026-11-05): a day's, reset at 00:00 UTC, but `stored`, a total. Past any, what it counts fails until the reset:
 * every room, not only what went past.
 */
export const FREE_PLAN: Record<keyof Omit<FreePlanToday, 'day' | 'live'>, number> = {
  objectRequests: 100_000,
  workerRequests: 100_000,
  rowsWritten: 100_000,
  rowsRead: 5_000_000,
  compute: 13_000,
  stored: 5_000_000_000,
};

/** What `side` used of `today`'s daily figures: the live site's own, or the rest, the previews'. Null when not known. */
export function sideOf(today: FreePlanToday, side: Side): DailyFigures | null {
  const live = today.live;
  if (!live) return null;
  if (side === 'live') return live;
  return Object.fromEntries(DAILY_LIMITS.map((k) => [k, Math.max(0, today[k] - live[k])])) as DailyFigures;
}

/**
 * The daily limit `side` has used most of its part of (`share` of each), and how much of that part (1 is all of it).
 * Null when its use is not known.
 */
export function fullestOf(today: FreePlanToday, side: Side, share = SIDE_SHARE): { limit: (typeof DAILY_LIMITS)[number]; share: number } | null {
  const mine = sideOf(today, side);
  if (!mine) return null;
  return DAILY_LIMITS.map((limit) => ({ limit, share: mine[limit] / (FREE_PLAN[limit] * share) })).reduce((a, b) => (b.share > a.share ? b : a));
}

/**
 * Which daily limit, if any, `side` has used its part of (`share` of each: SIDE_SHARE where its Worker keeps to it,
 * FREE_PLAN_SHARES in wrangler.jsonc), as `today`, the use last known, says of the day `now` is in. No share (0, the paid
 * plan), or the day's use not known: none.
 */
export function usedUp(today: FreePlanToday | null | undefined, now: number, side: Side, share: number | undefined): (typeof DAILY_LIMITS)[number] | null {
  if (!today || typeof share !== 'number' || !(share > 0) || today.day !== monthSoFar(now).to) return null;
  const fullest = fullestOf(today, side, share);
  return fullest && fullest.share >= 1 ? fullest.limit : null;
}

/** When the day `now` is in ends, UTC: the free plan's daily limits start again, and ours with them. */
export function dayEnds(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * How much of a side's share of a daily limit (SIDE_SHARE) it has used when the owner is told (scripts/quota-watch.mjs),
 * each once a day: early enough to act, and above a day with a couple of the previews' suite runs in it, which would
 * otherwise mail every day. A run of the browser suite against a preview (both engines) took some 10,000 to 13,000
 * requests to the Worker and some 7,000 to Durable Objects on 2026-11-17 (ticket 89): the Worker's are what the
 * previews' share runs out of first, after three or four runs; told at 70 %, one more is about what is left.
 */
export const ALERT_SHARES = [0.7, 0.9] as const;

/** The limits a day starts anew: all but `stored`, a total that the history's window keeps (ADR 0009). */
export const DAILY_LIMITS = ['compute', 'objectRequests', 'workerRequests', 'rowsWritten', 'rowsRead'] as const satisfies ReadonlyArray<keyof Omit<FreePlanToday, 'day' | 'live'>>;

/** The highest of ALERT_SHARES that `share` has reached, as a whole percentage (70, 90), or 0 for none. */
export function alertStep(share: number): number {
  return Math.round(Math.max(0, ...ALERT_SHARES.filter((s) => share >= s)) * 100);
}

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
 * Today's use of the free plan, the whole account's (UTC day), and the live site's part of it: its Worker by name
 * (`liveWorkers`), its Durable Objects by namespace (LIVE_NAMESPACES). Asked apart from the relay's: should Cloudflare
 * refuse a part of it, the relay's figure, which decides what keeps off the relay, still comes. `requests` by `type`: a
 * frame a hibernating room is woken for (`hibernation`, as the API names it: alarm, http, jsrpc are the others) is billed
 * as a twentieth of a request (`HIBERNATION_SHARE`). `duration` is GB-s (128 MB for each second a room is awake). Stored
 * bytes by namespace: the largest of the day of each, added up.
 *
 * A deleted Worker's Durable Objects leave the analytics with it, the day's figures and all: a preview is kept until the
 * day its PR closed has ended (preview-sweep.yml), or its use that day would go missing here while Cloudflare still
 * counts it (2026-11-17: the previews deleted that day had used tens of thousands of requests nobody saw).
 */
const FREE_PLAN_QUERY = `query($account: String!, $day: Date!, $live: String!) {
  viewer { accounts(filter: { accountTag: $account }) {
    objects: durableObjectsInvocationsAdaptiveGroups(limit: 2000, filter: { date_geq: $day, date_leq: $day }) { sum { requests } dimensions { type namespaceId } }
    workers: workersInvocationsAdaptive(limit: 1, filter: { date_geq: $day, date_leq: $day }) { sum { requests } }
    liveWorkers: workersInvocationsAdaptive(limit: 1, filter: { date_geq: $day, date_leq: $day, scriptName: $live }) { sum { requests } }
    periodic: durableObjectsPeriodicGroups(limit: 2000, filter: { date_geq: $day, date_leq: $day }) { sum { rowsRead rowsWritten duration } dimensions { namespaceId } }
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
  return graphql(apiToken, FREE_PLAN_QUERY, { account: accountId, day: monthSoFar(now).to, live: LIVE_SCRIPT });
}

/** A frame that wakes a hibernating room is billed as this much of a request (Durable Objects pricing, 20:1). */
const HIBERNATION_SHARE = 1 / 20;

/** The account's groups in an API answer; null for errors or another shape. */
function accountOf(json: unknown): Record<string, unknown> | null {
  const j = json as { data?: { viewer?: { accounts?: unknown[] } }; errors?: unknown[] } | null;
  if (j?.errors?.length) return null;
  return (j?.data?.viewer?.accounts?.[0] as Record<string, unknown> | undefined) ?? null;
}

/**
 * A group's rows added up by `take`, each a finite number of at least 0; null for a group missing or a row that is not.
 * `only`: the rows to add up, the others still checked.
 */
function sumGroup(account: Record<string, unknown>, group: string, take: (row: Record<string, unknown>) => unknown, only?: (row: Record<string, unknown>) => boolean): number | null {
  const rows = account[group];
  if (!Array.isArray(rows)) return null;
  let total = 0;
  for (const row of rows) {
    const n = take((row ?? {}) as Record<string, unknown>);
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    if (!only || only((row ?? {}) as Record<string, unknown>)) total += n;
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
 * Today's use of the free plan in the API's answer, and the live site's part of it; null for an answer without it. No
 * rows in a group: nothing used. Stored bytes are the largest of the day per namespace, added up: one Worker's rooms,
 * another's, a preview's.
 */
export function parseFreePlan(json: unknown, day: string): FreePlanToday | null {
  const a = accountOf(json);
  if (!a) return null;
  const isLive = (r: Record<string, unknown>) => LIVE_NAMESPACES.includes((r.dimensions as { namespaceId?: unknown } | undefined)?.namespaceId as string);
  const requests = (r: Record<string, unknown>) => {
    const n = sumOf('requests')(r);
    return typeof n === 'number' && (r.dimensions as { type?: unknown } | undefined)?.type === 'hibernation' ? n * HIBERNATION_SHARE : n;
  };
  const figures = (only?: (r: Record<string, unknown>) => boolean) => ({
    objectRequests: sumGroup(a, 'objects', requests, only),
    rowsWritten: sumGroup(a, 'periodic', sumOf('rowsWritten'), only),
    rowsRead: sumGroup(a, 'periodic', sumOf('rowsRead'), only),
    compute: sumGroup(a, 'periodic', sumOf('duration'), only),
  });
  const out = { ...figures(), workerRequests: sumGroup(a, 'workers', sumOf('requests')), stored: sumGroup(a, 'stored', (r) => (r.max as Record<string, unknown> | undefined)?.storedBytes) };
  const live = { ...figures(isLive), workerRequests: sumGroup(a, 'liveWorkers', sumOf('requests')) };
  if ([...Object.values(out), ...Object.values(live)].some((v) => v === null)) return null;
  return { day, ...(out as Omit<FreePlanToday, 'day' | 'live'>), live: live as DailyFigures };
}

/** The Worker's answer as the client reads it, or null. */
export function parseRelayUsage(json: unknown): RelayUsage | null {
  const u = json as Partial<RelayUsage> | null;
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!u || !num(u.bytes) || !num(u.limit) || u.limit === 0 || !num(u.asOf) || typeof u.since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(u.since)) return null;
  const t = u.today as Partial<FreePlanToday> | undefined;
  const keys = Object.keys(FREE_PLAN) as Array<keyof typeof FREE_PLAN>;
  // Its own fields only, copied one by one, as the relay's are. The live site's part, when it is whole.
  const l = t?.live as Partial<DailyFigures> | undefined;
  const live = l && DAILY_LIMITS.every((k) => num(l[k])) ? { live: Object.fromEntries(DAILY_LIMITS.map((k) => [k, l[k]])) as DailyFigures } : {};
  const today = t && typeof t.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.day) && keys.every((k) => num(t[k]))
    ? { today: { day: t.day, ...Object.fromEntries(keys.map((k) => [k, t[k]])), ...live } as FreePlanToday } : {};
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
