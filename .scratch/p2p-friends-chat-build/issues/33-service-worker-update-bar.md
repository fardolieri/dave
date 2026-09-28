# 33 · The app from a service worker, and a bar that asks for the update

Status: built 2026-09-27, not yet deployed
Asked for 2026-09-27: Daniel, first of seven goals (people list, encrypted history, direct messages, file offers, push,
signaling without Cloudflare follow): "I want a service worker that caches the app" and "The service worker should detect
new versions and offer a little banner where the user can click to update/reload the page." Decided with Daniel after
weighing auto-reload outside calls: no reload of its own at all. A new version shows a bar that cannot be dismissed, on
purpose a nag, and it takes room in the layout instead of floating over the call buttons or the composer.

## Scope
- A service worker caches the whole app shell at install (every built file but source maps, and the public icons and
  manifest) and answers the app's own requests and every page load from that cache. The WebSocket, PostHog and
  everything else pass by it.
- The page asks for a newer service worker when it starts, every few minutes, and when it comes back into view. A newer
  one installs beside the running one and waits; the running copy keeps its own files, so an old tab never asks the
  server for a file that the deploy removed.
- While one waits, a bar across the top of every screen says so, with a Reload button. The click activates the new
  one and reloads that tab. A reload in a call rejoins it (ticket 24).
- Not here: signaling without Cloudflare (goal 7). Offline, the app opens and shows the server as unavailable.

## Built
- `client/sw.ts`, built as a second entry of the client build to `/sw.js` (unhashed, at the root). `vite.config.ts`
  (`serviceWorker()`) writes `__PRECACHE__` into it: the list from `core/precache.ts` (every file but source maps, the
  worker itself and dotfiles; index.html as `/`) and a hash of those files, which names the cache (`dave-<hash>`) and
  changes the worker's bytes on every build that changes a file. Install copies hashed files an earlier version already
  has and downloads the rest past the HTTP cache, so an update costs what changed, not RNNoise's 5.7 MB again. Page loads
  get `/` and the app's files from this version, else the network. Activation deletes every earlier version and takes
  over a page nobody controlled (first install). About 6.3 MB on a first visit.
- `client/update.ts`: registers the worker (not in the dev server), looks for a new one every 5 minutes, when the page
  comes back into view and when it comes online, and sets `updateReady` while one waits. Reload sends it
  `skip-waiting` and reloads when it has taken over (5 s fallback).
- Only the tab that was clicked reloads, found while building: reloading every tab at once raced them for the tab lock
  (ticket 25), so a waiting tab could take the app, or Rejoin the call, instead of the tab that was in it. A waiting tab
  keeps its old version and shows no bar; once it takes over it shows the bar. Its old files are gone by then (only the
  newest version is kept, 2026-09-28, Daniel: "those other tabs are useless junk"), so what it has not loaded yet, the
  voice files, fails until its Reload.
- `client/App.tsx` (`UpdateBar`), `client/styles.css`: the bar above the `Switch`, on every screen but the waiting tab's. `#app` is a column,
  so the bar is a row of its own (43 px) and pushes the page down; no close button.
- E2E hook `__daveNextDeploy(tag)`: registers the worker as `/sw.js?deploy=<tag>`, kept in `dave.e2e-deploy`. Playwright
  cannot serve a changed `/sw.js` (the browser fetches the worker past its routes); another script URL is a new version to
  the browser, and from there the path is the real one.
- Spec §2.5 added.

## Verify
- `pnpm typecheck`, `pnpm test` (`test/precache.test.ts`), full `pnpm e2e` with Firefox.
- New `e2e/update.spec.ts`, Chromium and Firefox, repeated runs green: no bar on the first install; a deploy shows the
  bar with one button; a reload of her own keeps the old version and the bar; Reload moves the tab onto the new worker,
  the bar goes, the call is rejoined. Two tabs: only the clicked one reloads and it keeps the app and the call; the other
  does not reload and shows no bar; once it takes over ("Use it here instead") it shows the bar, and its Reload loads the
  new version. update + presence specs 3× in both engines: 48/48 (2026-09-28). Full suite that day: 3 failures outside
  the worker, both green alone: ticket 31's reconnect after a 65 s cut (backoff up to 30 s, the test waits 20 s) in
  both engines, and ticket 23's cue in Firefox. Every request to the
  server refused and the socket cut: a reload still opens the room, with its history, from the worker (not setOffline:
  Firefox's offline mode refuses the navigation before a worker is asked).
- Firefox: Playwright's injected script measuring during a load logs "Layout was forced before the page was fully loaded"
  (debugger eval code), once in three runs; added to the known Firefox noise, matched on that file only.
- Screenshots of the bar in a call, desktop 1440×900 at 2× and phone 390×844 at 3×: the page starts below it, the
  composer still ends at the bottom edge, nothing overflows.
- First e2e run on nightly (2026-09-28): a reload served by the worker is quick enough to meet the trickle of ICE candidates
  from the connection the friend is tearing down; Firefox rejected them ("InvalidStateError: No remoteDescription",
  2 in 16 against nightly, the volume-and-reload test). `client/call.ts` now drops candidates that arrive before any
  description: the real ones always follow theirs. The offline test waits for the server's echo before the cut (a
  line is kept only then), and the worklet-timeout noise pattern takes any top frame of the worklet.
- After deploy, still to do: a real deploy (new bytes, not another URL) shows the bar on an open nightly tab.
