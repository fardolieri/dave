# 77 · Flake: once, a sync after the reconnect asked from the live text, not from where the first asked

Status: open; the cause is not known yet
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
