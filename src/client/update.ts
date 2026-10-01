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
/** How long the opening check may take before the app goes on without its answer. */
const OPEN_CHECK_MS = 3000;
/** How long, from the page load, the app may stay frozen for a new version (Daniel, 2026-10-01). */
export const OPEN_FREEZE_MS = 10_000;

/**
 * The update the app looks for as it opens (ticket 36). A page a service worker already serves asks for a newer
 * version at once (`checking`). One found then, or one installed and waiting from before, is downloaded while the app
 * is frozen (`downloading`: Join, the composer and a Rejoin wait, the progress line shows), and once installed it takes
 * over and the page reloads by itself: nothing is lost in a page just opened. Anything else ends it (`over`): no new
 * version, no answer in time, a download past `OPEN_FREEZE_MS` or failed (the update bar asks once it is installed),
 * or this tab waiting behind another (ticket 25), which is not the one to reload.
 */
export type Opening = { kind: 'checking' } | { kind: 'downloading'; done: number; total: number } | { kind: 'over' };
const [opening, setOpening] = createSignal<Opening>({ kind: 'over' });
export const openingUpdate = opening;
/** The app waits for the opening update: no Join, no composer, no Rejoin. */
export const holding = (): boolean => opening().kind !== 'over';
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
  if (opening().kind === 'over') return;
  setOpening({ kind: 'over' });
  // Installed meanwhile but not taken (this tab waits behind another): the bar asks, once this tab runs the app.
  if (registration?.waiting) setReady(true);
}

function takeOpeningUpdate(): void {
  if (opening().kind === 'over' || applying) return;
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
    setOpening({ kind: 'checking' });
    setTimeout(() => {
      if (installed || opening().kind === 'over') return;
      if (opening().kind === 'downloading') posthog.capture('update_on_open_too_slow');
      endOpening();
    }, Math.max(0, OPEN_FREEZE_MS - performance.now()));
  }
  container.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { type?: string; done?: number; total?: number } | null;
    if (m?.type === PROGRESS && opening().kind !== 'over' && !installed) setOpening({ kind: 'downloading', done: m.done ?? 0, total: m.total ?? 0 });
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
      if (opening().kind === 'over') { setReady(true); return; }
      // Found as the app opened: taken, not offered.
      installed = true;
      const o = opening();
      setOpening({ kind: 'downloading', done: o.kind === 'downloading' ? o.total : 1, total: o.kind === 'downloading' ? o.total : 1 });
      if (runsApp) takeOpeningUpdate();
    };
    const downloading = (incoming: ServiceWorker | null) => {
      if (!incoming) return;
      if (opening().kind === 'checking') setOpening({ kind: 'downloading', done: 0, total: 0 });
      incoming.addEventListener('statechange', () => {
        if (incoming.state === 'installed') offerWaiting();
        else if (incoming.state === 'redundant' && !installed) endOpening(); // the download failed: the next check retries
      });
    };
    offerWaiting();
    downloading(reg.installing); // the browser's own check at the page load may have found it already
    reg.addEventListener('updatefound', () => downloading(reg.installing));
    if (opening().kind === 'checking') {
      const slow = setTimeout(() => { if (opening().kind === 'checking') endOpening(); }, OPEN_CHECK_MS);
      void reg.update().catch(() => {}).then(() => {
        clearTimeout(slow);
        if (opening().kind === 'checking' && !reg.installing && !reg.waiting) endOpening(); // nothing new
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
