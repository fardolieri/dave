# 77 · Flake: once, a sync after the reconnect asked from the live text, not from where the first asked

Status: fixed in the test 2026-11-27 (the test's race: it counted the room of two's syncs, see Cause); fixed once its ledger row stops growing
Type: flake

Seen 2026-11-10: the preview run of #131 at 33bc20f (run 42721836657), Chromium, shard 7, passed on its retry.
`text.spec.ts:337` "regression: a live text before the first sync is answered does not move where the next sync asks
from" (594e23c, the regression test of 802f595, new on master the same day). #131 changes no app code and nothing on this
test's path (tags on other tests, the Playwright config's grepInvert for them, workflows).

```
Error: asked again from where the first asked, not from the live text
- Expected: [0, 0]
+ Received: [1794267290998, 0]
```

2026-11-27: the gate of #200 at 83d1d7b (run 45960255147, attempt 1, Firefox shard 1), passed on its retry: the same
claim, the other way round, the first sync after the reconnect from 0 and the second from later
(`[0, 1795765270357]`); attempt 2 failed alike (`[1795765783695, 0]`). #200 changes theme CSS and a theme test only. One re-run of the failed job (`docs/agents/flakes.md`).

## What is known
Of the two syncs Bob sent after the test took its count (`asked`, once the live text was on screen), the first asked
from about the live text's time and the second from 0, as it should.

## Two readings, not yet told apart
- The app: a sync from the live text was still sent before the first was answered, through a path 802f595's fix does not
  cover (the point is kept before the first ask; something else asked from the newest line). That is the bug itself.
- The test: a sync the live text set off left after `asked` was read, and before the cut, so it counts as asked after the
  reconnect. Then the test's count is the race, and the app is right.

## Next
The failed try's trace and wire log (artifact `e2e-chromium-7-42721836657-1`, `Bob-wire.json`): when that sync went up
relative to the cut, and what set it off.

## Cause (2026-11-27)
The test's race, on a socket it did not mean to count. Both attempts of #200's gate run 45960255147 failed alike;
their wire logs (`e2e-firefox-1-45960255147-1` and `-2`, `Bob-wire.json`) show why. Bob has two sockets: the test's room,
and his room of two with Alice (ADR 0011), entered under a key of its own (another `you.publicKey` in its welcome). The
test counted the syncs of both. The room of two's first answer was still on its way when the test set
`bob.wire.down = null`, before `cut()`, which closes the sockets one after another: it came through, came in full, and
rightly moved that room's `historySynced` to its `upTo`. After the reconnect the room of two asked from there less
SYNC_OVERLAP_MS: in attempt 1, `[0, 1795765270357]` (its `upTo` 1795765570357); in attempt 2 the other order,
`[1795765783695, 0]`. The test's own room asked from 0 both times: the app did as it should. The 2026-11-10 failure,
`[1794267290998, 0]`, has attempt 2's shape, likely the same cause (its artifact not read).

Fix: the test lets answers through only after `cut()`, when no frame of an old socket can cross any more, and counts
its own room's syncs only (`wire.frames` takes a room; the wire log records each frame's socket).
