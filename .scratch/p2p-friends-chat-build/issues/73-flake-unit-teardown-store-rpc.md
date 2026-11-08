# 73 · Flake: the unit run fails on an environment torn down with a Room's keep to the Store still under way

Status: fixed in #126 (2026-11-09); fixed means no `Closing rpc` in the unit runs' logs after it

Seen 2026-11-08: ci.yml run 42432504223 (commit 216e743, branch sync/private-rooms, PR #126), job 128584295379. All 41
files and 507 tests passed, and the run failed on one unhandled error: `EnvironmentTeardownError: [vitest-worker]:
Closing rpc while "onUserConsoleLog" was pending`, "originated in test/turn.test.ts". The re-run (attempt 2) passed.

The same teardown, as an uncaught exception that does not fail the run (`Closing rpc while "resolve" was pending`), is in
the logs of green runs on that branch only: 42094047591 and 42096166742 (2026-11-05), 42372991992, 42374486775 and
42374614667 (2026-11-07); none in master's recent green runs. It shows locally too, once or twice per `pnpm test`, after
test/call.test.ts among others.

## Cause
#126 added the Store (ADR 0009). A Room hands every `sealed` or `file` frame it broadcasts to the Store in `waitUntil`
(src/worker/room.ts, `keep`), after the frame is answered, one keep after the other. A test file that ends right after
sending texts is torn down with keeps still on their way; vitest logs that, and fails the run when a console line of the
Room's is pending at that moment. Locally, test/call.test.ts alone showed it in every run (5 in 4 runs, one run twice),
the full suite in 2 runs of 3.

Its last test ("lets a burst of a hundred signals through…") sent 45 texts with the clock frozen and restored the clock as
soon as the first was refused. The room was still reading the last of them: with the clock running again the bucket
refilled, and a few were let through and kept after the test had ended, past any wait at its end (seen by logging each
keep's start against the file's end).

## Fix
- That test sends a `mute` after the texts, which the empty bucket refuses too, and waits for that answer before the clock
  runs again: by then the room has read every text.
- test/setup.ts, run in every file, waits at the file's end until every room the file opened has no keep, piece or forget
  under way (test/harness.ts, `keepsSettled`). It imports the harness only then: the harness loads the Worker, which
  turn.test.ts's `vi.mock` must come before. That was the 12 failures of the first try below.

After: call.test.ts alone 0 in 12 runs, the full suite 0 in 5 (508 tests each).

## Tried
- An `afterAll` in a setup file waiting 50 ms and then for the history Store's `usage()`: the teardown message stayed,
  and 12 tests failed (turn.test.ts, its mocks applied after the setup file had loaded the Worker). Reverted.
