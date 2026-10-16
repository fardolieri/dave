# 58 · Flake: the app's script was cut off on the first load, and the page stayed empty

Status: fixed on master 2026-10-16 (cadb931; nightly e2e passed for bc2393a), not released to prod yet; one question for
the owner below
Seen 2026-10-16: the preview run of PR #72 (38939823521, head 1e45988, against `dave-pr-72`), Chromium, shard 3, passed on
the retry: `presence.spec.ts:28` "rooms are separate: presence and text do not cross". Alice's `open()` found no composer
in 20 s, and her console had one line: "Failed to load resource: net::ERR_CONNECTION_RESET".

## What the trace shows
The page loaded (`/`, 200) and so did the stylesheet; `assets/index-DhPpobjG.js`, the whole app, started with 200 and
then the connection was reset under it. No socket was opened, no frame crossed the wire. The screenshot is the empty dark
first frame of index.html.

## Cause
A reset between the runner and Cloudflare in the middle of a response: not ours to prevent. What is ours is that the app
had no answer to it. A module script that fails to load runs nothing, so the page stayed empty for good, and a friend
would see the same on a first visit over a bad phone network (once the service worker is installed, the script comes
from its cache). Outcome 2 of ticket 35: fix the app.

## Fix
index.html reloads the page once when its own module script fails to load. A reload, not the script tried again: the
browser remembers a failed module for the page's life, so the bundle's own imports would fail again. A second failure
within 30 s does not reload again (`dave.load-retried` in sessionStorage), so a page offline stays where it is.

Tested by `resilience.spec.ts`: the first fetch of the script reset before any byte (the trace had it reset after the 200,
the same failure to the browser), and the first fetch answered with index.html, as for a page whose script went with a
deploy. Firefox calls the page a bounce tracker for reloading before any click; the test expects that warning.

## Open, for the owner
Not handled, and no worse than before: two failed loads within 30 s leave the page empty, as before the fix; a load that
fails slower than every 30 s reloads each time, each time the whole script over mobile data. One answer would be a line of
text with a Reload button after the second failure, or one more try when the tab comes back into view.

