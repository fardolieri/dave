import { createSignal, untrack } from 'solid-js';
import { parseRelayUsage, savesRelay, type RelayUsage } from '../core/relayusage';

/** How often an open tab asks the Worker again; the Worker keeps its answer about as long (worker/relayusage.ts). */
const EVERY_MS = 10 * 60_000;

/**
 * The relay's usage this month as last asked of the Worker: null where it has no token to ask Cloudflare with (204) or
 * before the first answer, 'unknown' when asking failed and nothing was known before. A failed ask keeps what was known.
 */
const [usage, setUsage] = createSignal<RelayUsage | 'unknown' | null>(null);
export const relayUsage = usage;

let asked = 0;
/** Asks the Worker now; of several asks under way, only the latest one's answer is taken. */
export async function refreshRelayUsage(): Promise<void> {
  const n = ++asked;
  const r = await fetch('/relay-usage', { cache: 'no-store' })
    .then(async (res) => (res.status === 204 ? null : (res.ok && parseRelayUsage(await res.json())) || 'unknown'))
    .catch(() => 'unknown' as const);
  if (n !== asked) return;
  if (r === 'unknown' && typeof untrack(usage) === 'object' && untrack(usage) !== null) return;
  setUsage(r);
}

/** Asks now and every EVERY_MS from then on, for as long as the page is open. */
export function watchRelayUsage(): void {
  void refreshRelayUsage();
  setInterval(() => void refreshRelayUsage(), EVERY_MS);
}

/** Screen shares and files keep off the relay (core/relayusage.ts, RELAY_SAVE_FROM). */
export function relaySaving(): boolean {
  const u = usage();
  return typeof u === 'object' && savesRelay(u, Date.now());
}
