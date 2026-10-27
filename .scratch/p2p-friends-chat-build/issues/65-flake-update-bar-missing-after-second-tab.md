# 65 · Flake: the update bar never shows when the deploy is staged right after a second tab opened

Status: open, cause likely (not proven); the test's, not the app's
Seen 5 times in 30 days, all branch runs against a local build, each passed on the retry: `update.spec.ts:69` "ticket 33:
Reload moves only its own tab; a tab waiting behind it is asked once it takes over". Chromium on 2026-10-16 (files/retry,
run 38923099129) and twice on 2026-10-21 (feature/private-threads, runs 39573928882 and 39576350056); both engines on
2026-10-15 (files/pull-over-webrtc, run 38817930237, which failed many tests with `toBeEnabled`, likely another cause).
The three Chromium ones fail at the same step: after `deploy(alice, 'next')`, `.update` never shows in Alice's tab within
20 s. Never seen against nightly or a preview, where the test skips itself (it needs the preview server).

## What the trace shows (run 39576350056, the `e2e-flaky-chromium-8` artifact)
The second tab opens, is controlled at once (the service worker is already active for the scope), and the test stages the
deploy (cookie, then `registration.update()`) about 100 ms later. Nothing after that: no bar for the 20 s.

## Likely cause
An update check of the second tab still in flight. A page that opens runs its own check (`client/update.ts`: the opening
check while it shows "checking", and `register()`), and the browser runs one at a navigation too. The Service Worker spec
coalesces an `update()` with an equivalent job still queued: it gets that job's promise. If that job fetched `/sw.js`
before the deploy cookie was set, it finds the same bytes, and the test's `update()` changes nothing. The app's next own
check is 5 min away (`CHECK_MS`), past the 20 s. The other `deploy()` calls in the file come long after their page loaded,
which fits that only this test is hit.

For a friend this is no bug: a deploy that lands during a check in flight is found at the next check.

## To do
Prove it, then fix the test, not the app: `deploy()` repeats `registration.update()` until the registration has an
installing or waiting worker (what the app's periodic check would do, sooner), or the test waits for the second tab's
opening check to end before staging. Then link the row in `causes.json` (branch `flake-ledger`).
