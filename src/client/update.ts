import { createSignal } from 'solid-js';
import posthog from './posthog';

/**
 * New versions (ticket 33). A deploy changes /sw.js (client/sw.ts); the browser installs the new service worker beside
 * the running one, where it waits. `updateReady` is then true and the update bar asks for a reload until it gets one:
 * nothing reloads on its own. The click lets the new one take over and reloads that tab only. Only the tab that runs the
 * app shows the bar (ticket 25); a tab waiting behind it keeps its old version and gets the bar if it takes over.
 * Reloading every tab at once would race them for the tab lock, and a waiting tab could end up with the app, or even
 * Rejoin the call, instead of the tab that was in it.
 * A version found as the app opens is no reason to ask (ticket 36): see `opening`.
 * The browser suite stages a deploy at the preview server (vite.config.ts, `e2eServer`) and asks for the check itself
 * through `navigator.serviceWorker`; nothing here is for tests.
 */
const CHECK_MS = 5 * 60 * 1000;
/** Tells the waiting service worker to take over; the same string is in sw.ts. */
const SKIP_WAITING = 'skip-waiting';
/** What the installing service worker sends about its download; the same string is in sw.ts. */
const PROGRESS = 'install-progress';
/**
 * How long a Reload waits for the new worker to take over before reloading anyway. Chromium holds the activation back
 * while the version before still counts as busy from serving the page load, and checks again only at a navigation:
 * right after a load (the opening update, ticket 36) controllerchange came half the time, and otherwise only with the
 * reload, which a 5 s wait made a frozen page for 5 s. A reload from 500 ms after the load on was always served by the
 * new version (2026-10-01, measured on the preview server). One too early is served by the old one, whose opening check
 * then takes the waiting version again.
 */
const TAKE_OVER_FALLBACK_MS = 1000;
/** How long the opening check may take before the app goes on without its answer: the rooms wait for it (Daniel, 2026-10-01). */
const OPEN_CHECK_MS = 1500;
/** How long, from the page load, the app may stay frozen for a new version (Daniel, 2026-10-01). */
export const OPEN_FREEZE_MS = 10_000;

/**
 * The update the app looks for as it opens (ticket 36). A page a service worker already serves asks for a newer
 * version at once (`checking`). One found then, or one installed and waiting from before, is downloaded while the app
 * is held (`downloading`: the rooms do not connect yet, so no friends show and nothing can be joined or sent), and once
 * installed it takes over and the page reloads by itself: nothing is lost in a page just opened. Anything else ends it
 * (`over`): no new version, no answer in time, a download past `OPEN_FREEZE_MS` (it goes on, under the line) or failed,
 * or this tab waiting behind another (ticket 25), which is not the one to reload.
 */
export type Opening = 'checking' | 'downloading' | 'over';
const [opening, setOpening] = createSignal<Opening>('over');
/** The app waits for the opening update: the rooms do not connect, nothing is joined, rejoined or sent. */
export const holding = (): boolean => opening() !== 'over';
/**
 * A new version downloading, however it was found: at the opening or by a later check. Bytes so far of the bytes it
 * downloads, both 0 until its first report. Shown as the line at the top (App.tsx); kept full once installed for the
 * opening update, whose reload follows, and gone once installed otherwise, when the bar asks.
 */
const [download, setDownload] = createSignal<{ done: number; total: number } | null>(null);
export const downloadProgress = download;
/** The worker whose progress the line shows, from `updatefound` to `installed` or `redundant`. */
let incoming: ServiceWorker | null = null;
/** Whether this tab runs the app, once the tab lock has said (App.tsx). */
let runsApp: boolean | undefined;
/** The opening update is installed and only waits for this tab to be the one that runs the app. */
let installed = false;

const [ready, setReady] = createSignal(false);
export const updateReady = ready;
let registration: ServiceWorkerRegistration | undefined;
/** This tab's Reload was clicked: the new service worker taking over is the moment to reload. */
let applying = false;
let offered = false;

/** The bar is on screen (App.tsx): counted once per page, and not for a tab that only learned of the version. */
export function noteOffered(): void {
  if (offered) return;
  offered = true;
  posthog.capture('update_offered');
}

/** Told by App.tsx once the tab lock has settled: only the tab that runs the app reloads for the opening update. */
export function tabSettled(held: boolean): void {
  runsApp = held;
  if (!held) endOpening();
  else if (installed) takeOpeningUpdate();
}

function endOpening(): void {
  if (opening() === 'over') return;
  setOpening('over');
  // Installed meanwhile but not taken (this tab waits behind another): the bar asks, once this tab runs the app.
  if (registration?.waiting) setReady(true);
}

function takeOpeningUpdate(): void {
  if (opening() === 'over' || applying) return;
  posthog.capture('update_taken_on_open', { ms: Math.round(performance.now()) });
  takeOver();
}

/** Registers the service worker and watches for a newer one: at start, every few minutes, and when the page comes back into view. */
export function watchForUpdates(): void {
  // The dev server has no service worker: it would serve stale modules past Vite's own reloading.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  // The first visit has nothing older to be frozen in; every later page load starts on the version it has, and asks.
  if (container.controller) {
    setOpening('checking');
    setTimeout(() => {
      if (installed || opening() === 'over') return;
      if (opening() === 'downloading') posthog.capture('update_on_open_too_slow');
      endOpening();
    }, Math.max(0, OPEN_FREEZE_MS - performance.now()));
  }
  container.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { type?: string; done?: number; total?: number } | null;
    if (m?.type === PROGRESS && incoming) setDownload({ done: m.done ?? 0, total: m.total ?? 0 });
  });
  container.startMessages();
  // The first service worker takes over a page nobody controlled, and that is no update. A later change is one: this
  // tab's Reload (reload now), or another tab's (this one now runs behind the service worker, so it asks for a reload).
  let controlled = container.controller !== null;
  container.addEventListener('controllerchange', () => {
    if (applying) location.reload();
    else if (controlled) setReady(true);
    controlled = true;
  });
  container.register('/sw.js').then((reg) => {
    registration = reg;
    const offerWaiting = () => {
      if (!reg.waiting || !container.controller) return;
      if (opening() === 'over') { setReady(true); return; }
      // Found as the app opened: taken, not offered. The line stays, full, until the reload.
      installed = true;
      setDownload({ done: 1, total: 1 });
      if (runsApp) takeOpeningUpdate();
    };
    const downloading = (worker: ServiceWorker | null) => {
      // The first install, into a page nobody controlled, caches the app; it is no new version and shows nothing.
      if (!worker || !container.controller) return;
      incoming = worker;
      setDownload({ done: 0, total: 0 });
      if (opening() === 'checking') setOpening('downloading');
      worker.addEventListener('statechange', () => {
        if (worker.state !== 'installed' && worker.state !== 'redundant') return;
        if (incoming === worker) incoming = null;
        if (worker.state === 'installed') { offerWaiting(); if (!installed) setDownload(null); return; }
        // The download failed: the line goes, and the next check retries.
        setDownload(null);
        if (!installed) endOpening();
      });
    };
    offerWaiting();
    downloading(reg.installing); // the browser's own check at the page load may have found it already
    reg.addEventListener('updatefound', () => downloading(reg.installing));
    if (opening() === 'checking') {
      const slow = setTimeout(() => { if (opening() === 'checking') endOpening(); }, OPEN_CHECK_MS);
      void reg.update().catch(() => {}).then(() => {
        clearTimeout(slow);
        if (opening() === 'checking' && !reg.installing && !reg.waiting) endOpening(); // nothing new
      });
    }
    const check = () => { reg.update().catch(() => {}); }; // offline, or the server down: the next check tries again
    setInterval(check, CHECK_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    window.addEventListener('online', check);
  }, (e: unknown) => { endOpening(); console.warn('service worker not registered', e); });
}

/** The update bar's Reload. A reload in a call rejoins it (ticket 24). */
export function applyUpdate(): void {
  posthog.capture('update_applied');
  takeOver();
}

/** Lets the waiting version take over and reloads this tab on it. */
function takeOver(): void {
  const waiting = registration?.waiting;
  // None waiting: another tab's Reload already made the new version the running one, and this tab only has to load it.
  if (!waiting) { location.reload(); return; }
  applying = true;
  waiting.postMessage(SKIP_WAITING);
  // controllerchange reloads; should it not come soon, the reload still happens, and the new worker takes over at it.
  setTimeout(() => location.reload(), TAKE_OVER_FALLBACK_MS);
}
