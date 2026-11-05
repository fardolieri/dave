# 73 · Flake: the unit run fails on an environment torn down with a Room's keep to the Store still under way

Status: needs-triage (cause suspected, not fixed); must be fixed before #126 lands on master

Seen 2026-11-08: ci.yml run 42432504223 (commit 216e743, branch sync/private-rooms, PR #126), job 128584295379. All 41
files and 507 tests passed, and the run failed on one unhandled error: `EnvironmentTeardownError: [vitest-worker]:
Closing rpc while "onUserConsoleLog" was pending`, "originated in test/turn.test.ts". The re-run (attempt 2) passed.

The same teardown, as an uncaught exception that does not fail the run (`Closing rpc while "resolve" was pending`), is in
the logs of green runs on that branch only: 42094047591 and 42096166742 (2026-11-05), 42372991992, 42374486775 and
42374614667 (2026-11-07); none in master's recent green runs. It shows locally too, once or twice per `pnpm test`, after
test/call.test.ts among others.

## Suspected cause
#126 added the Store (ADR 0009). A Room hands every `sealed` or `file` frame it broadcasts to the Store in `waitUntil`
(src/worker/room.ts, `keep`), after the frame is answered. Test files that send texts (call, presence, turn, worker) end
with keeps still on their way to the Store, and vitest tears the environment down in the middle of one. Usually that is
only logged; when a console line of the Room's (a `socket end` log) is pending at that moment, vitest counts it as an
unhandled error.

## Tried
- An `afterAll` in a setup file waiting 50 ms and then for the history Store's `usage()`: the teardown message stayed,
  and 12 tests failed (the Store tests share the history Store's totals). Reverted.

## Next
Find which keep is pending (log the Room's keeps against test end), then either await the Room's `keeping` from the test
harness at the end of each test that sends texts, or give tests a Store binding that answers at once.
