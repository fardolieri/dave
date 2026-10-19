# 50 · Flake: PostHog did not start in 20 s after the yes (not pinned down)

Status: likely found, shipped 2026-10-19 to prod (7a8ed3d, nightly e2e green first); fixed on branch flake/59-closed-friend-goodbye (outcome 1 of ticket 35, the test is wrong); shipped 2026-10-14 to prod (41657fb): the e2e workflow now keeps the failed try of a test that passed on its retry
Seen 2026-10-12: e2e run 38252207798 (local build, branch flake/worker-test-nightly), job 114821122667, Firefox shard 3:
`privacy.spec.ts` "a yes starts PostHog and tells the server; stopping forgets it again" failed on its first try and
passed on the retry (8.5 s). After the click on "Sure!", no request to PostHog in 20 s ("PostHog started after the yes",
0 requests). The shard ran two workers; the other one ran `resilience.spec.ts` meanwhile.

## What is known
The job passed, so nothing of the failed try was kept: no trace, no screenshot, no console. Only the log, which shows the
one failed poll and no console problems (a "PostHog did not load" warning would have been one).

What has to happen after the click (`setConsent('on')` in `client/posthog.ts`): `start()` imports posthog-js (a chunk of
our own origin), `init` asks PostHog for its remote config (`config.js` and the like: the first requests the test
sees), then sends events. Zero requests means one of:
1. the click did not reach the button: the notice's bubble pops in (a 0.35 s scale animation after a 0.45 s delay),
   but Playwright's click checks its target as the events fire and retries a miss, so it is unlikely;
2. `start()` returned at once: only while an earlier import is under way (`loading`), and none was, with no consent at load;
3. the import did not settle in 20 s: it did not fail (no warning), so it hung, e.g. at the service worker, which on a
   first visit is installing and then claims the page around this time;
4. posthog-js loaded but sent nothing: not seen in any run.

## Ruled out by trying
Diagnostic branch diag/privacy-yes-50 (not merged): the test with a timeline of the page's requests, console, service
worker `controllerchange`, clicks and reloads, printed when PostHog does not start.
- e2e run 38281095436, local build: the test alone, 40 times per engine: 80 of 80 passed.
- e2e run 38281987922, local build: the test with the resilience tests of the failed shard beside it on the second
  worker, 16 times each: all passed.
So it is rarer than 1 in 100 runs; no regression test could be written without knowing which of the above it was.

## Done
`e2e.yml` uploads `e2e-results` also from a job that passed, as `e2e-flaky-<engine>-<shard>-<run>`: a test that failed
once and passed on its retry kept its trace and wire logs (`retain-on-failure`), and they are now there to read. Next
time, its trace answers the question: the "Sure!" click and its target, the request for the posthog-js chunk and whether
it finished, the service worker's state.

## Left as it is
The flake, until it shows again with its trace.

## Seen with its trace (2026-10-19)
The kept failed tries of 2026-10-15 (e2e runs 38721164482 and 38764424455, Firefox) were the neighbouring test
"a yes during the handshake…": the auth went up without the yes, and no `telemetry` frame followed it either. The page
snapshot after the failure still has the notice open, which "Sure!" closes: the click Playwright reported done did not
reach the button. It came about 0.55 s after the load, inside the bubble's pop-in (`bubble-pop .35s .45s`, scaling from
0.6 around its corner): Playwright found the button stable while the bubble waited at its first frame, and by the click
it had moved. Ticket 50's run had the same shape, zero requests after a click early after the load, so most likely the
same miss; not proven, its try was not kept. The privacy tests now wait for the notice's animations to end before they
answer it (`answer`, privacy.spec.ts). The same kind of miss as ticket 57's Join click: layout moving under a click.
