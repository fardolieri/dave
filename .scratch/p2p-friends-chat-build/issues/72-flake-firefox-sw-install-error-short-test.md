# 72 · Flake: Firefox says the service worker's install failed in a test that ends within seconds of opening

Status: open, cause suspected, not proven
Type: flake

Seen 2026-10-30: the preview run of PR #114 at 8c1593b (run 41114344125), Firefox, shard 5, passed on its retry, so the
gate to master went red: `resilience.spec.ts:694` "a call whose audio device fails under it plays again". The fixture's
console check failed on one line of Alice's: `service worker not registered TypeError: ServiceWorker script at
https://dave-pr-114.…/sw.js for scope … encountered an error during installation.` (`client/update.ts`, `register()`
rejected). The ledger had no earlier sighting with this error.

Not the change: PR #114 changes the wording of a file card of mine (`App.tsx`, `FileView`); it touches neither the
service worker nor this test, which in Firefox skips itself (no running AudioContext on the runner) and so ended 5 s
after the pages opened.

## Suspected cause
A test that short ends while a fresh page's service worker is still installing: the install downloads every file of the
build, RNNoise's 5.7 MB among them, and one failed fetch fails it (`client/sw.ts`). Either the teardown closing the
context cuts the install off and Firefox rejects `register()` before the page stops being watched, or one fetch against
the preview failed. The first would be the test's (an install cut off by a closing tab is not an app problem); the
second the app's, as a page then runs without the offline copy until the next check.

## To do
Read the failed try's trace (`e2e-firefox-5-41114344125-1` artifact, 14 days): the time of the warning against the
test's end and the context's close, and whether a fetch of a precached file failed. Then fix the fixture (an install cut
off by teardown is expected) or the app accordingly.
