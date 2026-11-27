# 97 · Flake: Alice's giga bonk counted as a shared round, not her win

Status: open; cause suspected, not proven
Type: flake

Seen 2026-11-27, the gate of #205 at 0443253 (run 45964640230, attempt 1, Chromium shard 5), passed on the re-run:
`game.spec.ts:23` "a game: started from the call in one click, joined from its tile, rounds counted down and played, a
bonk felt on both sides", the step "Alice sees Alice win" (line 77):

```
  Object {
+   "BI8o_ge89Rv": 1,
    "BIn-xxLKXiu": 1,
  }
```

Both players were counted a win: the round was shared, as two who fall within TIE_MS (500 ms, core/bonk.ts) share it
since ba623b2 (2026-11-26). #205 changes how a bonk's thump reaches the speakers (the cues' context sleeps between
sounds), nothing of the game's state or rounds; the evidence cleared it and the gate's one re-run passed.

## Suspected cause (not proven)
The test holds Alice's arrow key down until a read of Bob's page sees him pushed, then lifts it. On a page drawing its
game in software a read takes a third of a second to over one (ticket 93), so Alice keeps rolling the while, and may
follow Bob off the floe within TIE_MS of him. Before ba623b2 the last one standing won whatever came after; now that
counts as a tie.

## Next
The failed try's trace (artifact `e2e-chromium-5-45964640230-1`): whether Alice's ball left the floe, and when, against
Bob's fall. If so, the fix is in the test (lift the key as the bonk lands, or keep Alice from the edge), not the app.
