import { createSignal } from 'solid-js';
import posthog from './posthog';
import { exposeHooks } from './hooks';
import { local } from './storage';

/**
 * New versions (ticket 33). A deploy changes /sw.js (client/sw.ts); the browser installs the new service worker beside
 * the running one, where it waits. `updateReady` is then true and the update bar asks for a reload until it gets one:
 * nothing reloads on its own. The click lets the new one take over and reloads that tab only. Only the tab that runs the
 * app shows the bar (ticket 25); a tab waiting behind it keeps its old version and gets the bar if it takes over.
 * Reloading every tab at once would race them for the tab lock, and a waiting tab could end up with the app, or even
 * Rejoin the call, instead of the tab that was in it.
 */
const CHECK_MS = 5 * 60 * 1000;
/**
 * The service worker's URL. A test's pretend deploy (`__daveNextDeploy`) moves it, and it has to stay there across
 * reloads: registering the plain URL again would be one more new version.
 */
const DEPLOY_KEY = 'e2e-deploy';
const scriptUrl = (): string => {
  const tag = exposeHooks ? local.get(DEPLOY_KEY) : null;
  return tag ? `/sw.js?deploy=${encodeURIComponent(tag)}` : '/sw.js';
};
/** Tells the waiting service worker to take over; the same string is in sw.ts. */
const SKIP_WAITING = 'skip-waiting';

const [ready, setReady] = createSignal(false);
export const updateReady = ready;
let registration: ServiceWorkerRegistration | undefined;
/** This tab's Reload was clicked: the new service worker taking over is the moment to reload. */
let applying = false;

function offer(): void {
  if (ready()) return;
  setReady(true);
  posthog.capture('update_offered');
}

/** Registers the service worker and watches for a newer one: at start, every few minutes, and when the page comes back into view. */
export function watchForUpdates(): void {
  // The dev server has no service worker: it would serve stale modules past Vite's own reloading.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  // The first service worker takes over a page nobody controlled, and that is no update. A later change is one: this
  // tab's Reload (reload now), or another tab's (this one now runs behind the service worker, so it asks for a reload).
  let controlled = container.controller !== null;
  container.addEventListener('controllerchange', () => {
    if (applying) location.reload();
    else if (controlled) offer();
    controlled = true;
  });
  container.register(scriptUrl()).then((reg) => {
    registration = reg;
    const offerWaiting = () => { if (reg.waiting && container.controller) offer(); };
    offerWaiting();
    reg.addEventListener('updatefound', () => {
      const incoming = reg.installing;
      incoming?.addEventListener('statechange', () => { if (incoming.state === 'installed') offerWaiting(); });
    });
    // A deploy, as far as the browser can tell: the worker under another script URL counts as a new version, even with the
    // same bytes, and installs and waits like one. Playwright cannot serve a changed /sw.js: the browser fetches it past its routes.
    if (exposeHooks) (window as unknown as { __daveNextDeploy?: (tag: string) => Promise<unknown> }).__daveNextDeploy = (tag) => { local.set(DEPLOY_KEY, tag); return container.register(scriptUrl()); };
    const check = () => { reg.update().catch(() => {}); }; // offline, or the server down: the next check tries again
    setInterval(check, CHECK_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    window.addEventListener('online', check);
  }, (e: unknown) => console.warn('service worker not registered', e));
}

/** The update bar's Reload. A reload in a call rejoins it (ticket 24). */
export function applyUpdate(): void {
  posthog.capture('update_applied');
  const waiting = registration?.waiting;
  // None waiting: another tab's Reload already made the new version the running one, and this tab only has to load it.
  if (!waiting) { location.reload(); return; }
  applying = true;
  waiting.postMessage(SKIP_WAITING);
  // controllerchange reloads; should it never come, the reload still happens, and the new worker takes over at the next.
  setTimeout(() => location.reload(), 5000);
}
