import { createSignal } from 'solid-js';
import posthog from './posthog';

/**
 * One tab at a time (ticket 25). The tab that holds the Web Lock is the one with sockets; any other tab of this
 * browser shows a notice, opens nothing, and leaves the first tab alone. Deciding here, before a socket exists,
 * keeps the server's rule (a newer socket supersedes an older one, which clears ghosts after a reconnect) as a
 * backstop only.
 *
 * - `held`: this tab runs the app. `mayRejoin` is true only when the lock came at once or within the reload grace:
 *   a reload frees the old page's lock a moment after the new page asks, while a tab that waited behind another open
 *   tab is not a reload, and must not Rejoin a call that tab just left by closing.
 *   A reload of the tab that held the lock steals it back instead of queueing: a waiting tab is ahead in the queue and
 *   would otherwise inherit the app, and the call, from a refresh. The tab knows it held the lock from a sessionStorage
 *   flag (per tab, survives the reload) and knows it reloaded from the navigation entry, so a duplicated tab, which
 *   copies sessionStorage, still queues.
 * - `waiting`: another tab holds the lock. The request stays queued, so this tab takes over by itself once the other
 *   closes; `takeOver` steals the lock instead, and the tab it was stolen from falls back to waiting.
 */
export type TabState = { kind: 'checking' } | { kind: 'held'; mayRejoin: boolean } | { kind: 'waiting' };

const NAME = 'dave-tab';
/** How long a reloading page waits for its previous self to let go before it says another tab is open. */
export const RELOAD_GRACE_MS = 2000;
const HELD_FLAG = 'dave.tabHeld';
const session = {
  get: () => { try { return sessionStorage.getItem(HELD_FLAG) === '1'; } catch { return false; } },
  set: (on: boolean) => { try { if (on) sessionStorage.setItem(HELD_FLAG, '1'); else sessionStorage.removeItem(HELD_FLAG); } catch { /* storage blocked */ } },
};
const reloaded = () => (performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload';
const forever = () => new Promise<void>(() => {}); // held until the tab goes away or another tab steals it

export function createTabLock() {
  const [state, setState] = createSignal<TabState>({ kind: 'checking' });
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  /** Run before this tab steps back, while its sockets are still open: the call says goodbye instead of dropping. */
  const stepBack = new Set<() => void>();
  const onStepBack = (fn: () => void) => { stepBack.add(fn); return () => stepBack.delete(fn); };
  // No Web Locks (an insecure context, an old browser): behave as before, the server settles two tabs.
  if (!locks) { setState({ kind: 'held', mayRejoin: true }); return { state, takeOver: () => {}, onStepBack }; }

  /** Withdraws this tab's queued request before a take-over, so it cannot also be granted later. */
  let queued: AbortController | null = null;

  function queue(atLoad: boolean): void {
    const ctl = new AbortController();
    queued = ctl;
    const started = Date.now();
    let granted = false;
    const timer = atLoad ? setTimeout(() => { if (!granted) { setState({ kind: 'waiting' }); posthog.capture('tab_waiting'); } }, RELOAD_GRACE_MS) : undefined;
    if (!atLoad) setState({ kind: 'waiting' });
    locks!.request(NAME, { signal: ctl.signal }, () => {
      granted = true;
      queued = null;
      clearTimeout(timer);
      grant(atLoad && Date.now() - started < RELOAD_GRACE_MS);
      return forever();
    }).catch(() => {
      clearTimeout(timer);
      if (ctl.signal.aborted) return; // withdrawn for a take-over
      lost(); // stolen by another tab's take-over: wait in line again
    });
  }

  function grant(mayRejoin: boolean): void {
    session.set(true);
    setState({ kind: 'held', mayRejoin });
  }

  /** `reload`: this page is the refresh of the tab that held the lock, so a call it was in may be rejoined. */
  function steal(reload: boolean): void {
    queued?.abort();
    queued = null;
    locks!.request(NAME, { steal: true }, () => { grant(reload); return forever(); })
      .catch(lost); // stolen in turn
  }

  // The page going away (a reload stealing the lock back from it included) must not step back: that would leave the
  // call and remove the Rejoin marker the next page is about to read.
  let unloading = false;
  window.addEventListener('pagehide', () => { unloading = true; });
  window.addEventListener('pageshow', () => { unloading = false; });

  function lost(): void {
    if (unloading) return;
    session.set(false);
    for (const fn of stepBack) fn();
    queue(false);
  }

  if (session.get() && reloaded()) steal(true); else queue(true);
  return { state, takeOver: () => { posthog.capture('tab_taken_over'); steal(false); }, onStepBack };
}
