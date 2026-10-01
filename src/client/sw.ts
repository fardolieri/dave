// The service worker (ticket 33), built on its own as /sw.js. It keeps the whole app in a cache of its own and answers
// every page load and the app's own files from there. vite.config.ts writes the build's file list and its version (the
// build time, then a hash of the files: core/precache.ts) into __PRECACHE__, so each deploy changes this file's bytes,
// which is what makes the browser install it as a new version. The new one waits beside the running one until the
// page's update bar sends SKIP_WAITING. Imports nothing: anything shared with the page would become a chunk both load.

/** `sizes[i]` is the byte size of `urls[i]`, for the install's progress (ticket 36). */
declare const __PRECACHE__: { version: string; urls: string[]; sizes: number[] };

// The service worker scope, as much of it as this file uses. The WebWorker lib cannot sit beside DOM in one program.
type ExtendableEvent = Event & { waitUntil(p: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & { readonly request: Request; respondWith(r: Promise<Response>): void };
type Scope = {
  addEventListener(type: 'install' | 'activate', listener: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (e: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: {
    claim(): Promise<void>;
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<{ postMessage(message: unknown): void }[]>;
  };
  readonly location: Location;
};
const sw = self as unknown as Scope;

const { version, urls, sizes } = __PRECACHE__;
const CACHE = `dave-${version}`;
const cached = new Set(urls);
/** The build time in a cache name, the rule of `cacheVersion` in core/precache.ts; a name from before the stamp is older than any. */
const builtAt = (name: string): number => { const m = /^dave-([0-9a-z]+)-/.exec(name); return m ? parseInt(m[1]!, 36) : 0; };
/** This version's cache, opened once: every page load and file goes through it. */
const cache = caches.open(CACHE);
/** Sent by the page (client/update.ts) when the update bar's Reload is clicked. */
const SKIP_WAITING = 'skip-waiting';
/** Sent to the open pages while installing: `{ type: PROGRESS, done, total }` in bytes. The same string is in update.ts. */
const PROGRESS = 'install-progress';

sw.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const own = await cache;
    // A hashed file never changes under its name: one an earlier version already has is not downloaded again, so an
    // update costs only what changed (RNNoise alone is 5.7 MB).
    const earlier = await Promise.all(urls.map((url) => (url.startsWith('/assets/') ? caches.match(url) : undefined)));
    // The pages hear how far the download is (ticket 36): a page that opened on the version before shows it as a line
    // while it waits to reload. Bytes, not files, and only those downloaded; at most ten reports a second.
    const total = urls.reduce((sum, _, i) => (earlier[i] ? sum : sum + sizes[i]!), 0);
    let done = 0;
    let reported = 0;
    const report = async (last: boolean) => {
      if (!last && Date.now() - reported < 100) return;
      reported = Date.now();
      for (const page of await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })) page.postMessage({ type: PROGRESS, done: Math.min(done, total), total });
    };
    void report(false);
    await Promise.all(urls.map(async (url, i) => {
      const copy = earlier[i];
      if (copy) return own.put(url, copy);
      // Past the HTTP cache, so the file is this deploy's. One failed file fails the install; the next update check retries.
      const res = await fetch(url, { cache: 'reload' });
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      // Counted as it streams in, on a copy, while the original goes into the cache.
      const counted = res.clone().body?.getReader();
      const stored = own.put(url, res);
      for (let chunk = await counted?.read(); chunk && !chunk.done; chunk = await counted!.read()) { done += chunk.value.byteLength; void report(false); }
      await stored;
    }));
    await report(true);
  })());
});

sw.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Older versions go. Another tab still on one of them is left without its files: it shows the update bar once it
    // runs the app, and anything it has not loaded yet (the voice files) waits for that reload. A newer version stays:
    // one found by a check while this one waited may be installing into its cache right now.
    for (const key of await caches.keys()) if (key.startsWith('dave-') && key !== CACHE && builtAt(key) < builtAt(CACHE)) await caches.delete(key);
    // Every activation takes over the open pages, so each is served from here from its next request on. The page's
    // `controllerchange` listener (client/update.ts) waits for exactly this: after SKIP_WAITING it is what reloads the
    // tab whose Reload was clicked, and what offers the bar to a tab that runs the app behind another tab's Reload.
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
  e.respondWith((async () => (await (await cache).match(key)) ?? fetch(req))());
});
