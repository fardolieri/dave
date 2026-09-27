# 33 · The app from a service worker, and a bar that asks for the update

Status: building
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
  one and every tab of the app reloads. A reload in a call rejoins it (ticket 24).
- Not here: signaling without Cloudflare (goal 7). Offline, the app opens and shows the server as unavailable.
