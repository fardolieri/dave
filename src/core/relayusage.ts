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

/** What the Worker's `/relay-usage` answers: bytes sent since `since` (the 1st of this month, UTC, `YYYY-MM-DD`), as of `asOf`. */
export type RelayUsage = { bytes: number; limit: number; since: string; asOf: number };

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

export function relayUsageRequest(accountId: string, apiToken: string, now: number): CredentialRequest {
  const { from, to } = monthSoFar(now);
  return {
    url: 'https://api.cloudflare.com/client/v4/graphql',
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { account: accountId, from, to } }),
  };
}

/** The bytes sent in the API's answer, TURN and SFU together; null for errors or an answer of another shape. No traffic is no rows: 0. */
export function parseRelayBytes(json: unknown): number | null {
  const j = json as { data?: { viewer?: { accounts?: unknown[] } }; errors?: unknown[] } | null;
  if (j?.errors?.length) return null;
  const account = j?.data?.viewer?.accounts?.[0] as Record<string, unknown> | undefined;
  if (!account || !Array.isArray(account.turn) || !Array.isArray(account.sfu)) return null;
  let bytes = 0;
  for (const row of [...account.turn, ...account.sfu]) {
    const b = (row as { sum?: { egressBytes?: unknown } } | null)?.sum?.egressBytes;
    if (typeof b !== 'number' || !Number.isFinite(b) || b < 0) return null;
    bytes += b;
  }
  return bytes;
}

/** The Worker's answer as the client reads it, or null. */
export function parseRelayUsage(json: unknown): RelayUsage | null {
  const u = json as Partial<RelayUsage> | null;
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!u || !num(u.bytes) || !num(u.limit) || u.limit === 0 || !num(u.asOf) || typeof u.since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(u.since)) return null;
  return { bytes: u.bytes, limit: u.limit, since: u.since, asOf: u.asOf };
}

/** Bytes as Cloudflare bills them, in powers of 1000: "830 MB", "14.1 GB", "1 TB". */
export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${i === 0 || n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} ${units[i]}`;
}

/** "14.1 GB of 1 TB (1.4%)": the share rounded to a tenth below 10 %, then whole. */
export function formatShare(bytes: number, of: number): string {
  const pct = (bytes / of) * 100;
  const shown = pct > 0 && pct < 0.1 ? '<0.1' : pct < 10 ? (Math.round(pct * 10) / 10).toString() : Math.round(pct).toString();
  return `${formatBytes(bytes)} of ${formatBytes(of)} (${shown}%)`;
}
export const formatRelayUsage = (u: RelayUsage): string => formatShare(u.bytes, u.limit);
