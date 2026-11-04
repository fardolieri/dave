import type { HistoryUsage } from '../core/kept';
import { STORE_NAME } from './store';

/**
 * `/history-usage`: how full the server's history is (ADR 0009, worker/store.ts), for the About dialog. Kept a minute per
 * isolate, so a stranger asking over and over wakes the Store once a minute at most. A failure is a 200 with `error`,
 * which the dialog shows as not known: an error status would be logged in the browser's console.
 */
export const HISTORY_USAGE_PATH = '/history-usage';

const KEEP_MS = 60_000;
let kept: { at: number; usage: HistoryUsage | null } | null = null;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function historyUsage(env: Env, now = Date.now()): Promise<Response> {
  if (!kept || now - kept.at > KEEP_MS) {
    let usage: HistoryUsage | null = null;
    try {
      usage = await env.STORE.get(env.STORE.idFromName(STORE_NAME)).usage();
    } catch (e) {
      console.log('history usage not known', JSON.stringify({ reason: String(e) }));
    }
    kept = { at: now, usage };
  }
  return json(kept.usage ?? { error: 'unavailable' });
}

/** Tests only: forget the kept answer. */
export function forgetHistoryUsage(): void {
  kept = null;
}
