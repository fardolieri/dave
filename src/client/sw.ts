// The service worker (ticket 33), built on its own as /sw.js. It keeps the whole app in a cache of its own and answers
// every page load and the app's own files from there. vite.config.ts writes the build's file list and a hash of their
// contents into __PRECACHE__, so each deploy changes this file's bytes, which is what makes the browser install it as a
// new version. The new one waits beside the running one until the page's update bar sends SKIP_WAITING.
// Imports nothing: anything shared with the page would become a chunk both load.

declare const __PRECACHE__: { version: string; urls: string[] };

// The service worker scope, as much of it as this file uses. The WebWorker lib cannot sit beside DOM in one program.
type ExtendableEvent = Event & { waitUntil(p: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & { readonly request: Request; respondWith(r: Promise<Response>): void };
type Scope = {
  addEventListener(type: 'install' | 'activate', listener: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (e: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  readonly location: Location;
};
const sw = self as unknown as Scope;

const { version, urls } = __PRECACHE__;
const CACHE = `dave-${version}`;
const cached = new Set(urls);
/** Sent by the page (client/update.ts) when the update bar's Reload is clicked. */
const SKIP_WAITING = 'skip-waiting';

sw.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(urls.map(async (url) => {
      // A hashed file never changes under its name: one an earlier version already has is not downloaded again, so an
      // update costs only what changed (RNNoise alone is 5.7 MB).
      const earlier = url.startsWith('/assets/') ? await caches.match(url) : undefined;
      if (earlier) return cache.put(url, earlier);
      // Past the HTTP cache, so the file is this deploy's. One failed file fails the install; the next update check retries.
      const res = await fetch(url, { cache: 'reload' });
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return cache.put(url, res);
    }));
  })());
});

sw.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Only this version is kept. Another tab still on the one before is left without its files: it shows the update
    // bar once it runs the app, and anything it has not loaded yet (the voice files) waits for that reload.
    for (const key of await caches.keys()) if (key.startsWith('dave-') && key !== CACHE) await caches.delete(key);
    // The first install takes over the open page at once, so it is served from here from its next request on.
    await sw.clients.claim();
  })());
});

sw.addEventListener('message', (e) => { if (e.data === SKIP_WAITING) void sw.skipWaiting(); });

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return; // PostHog and the like go past untouched
  // Every page load is the single-page app, whatever the path (wrangler.jsonc: not_found_handling).
  const key = req.mode === 'navigate' ? '/' : url.pathname;
  if (!cached.has(key)) return;
  e.respondWith((async () => (await (await caches.open(CACHE)).match(key)) ?? fetch(req))());
});
