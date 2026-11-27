# 98 · Flake: Alice and Bob each name another leader, at one read, as the first round starts

Status: open; cause not looked for
Type: flake

Seen 2026-11-27, the gate of #200 at 0d18272 (run 45966429580, attempt 1, Firefox shard 5):
`game.spec.ts:23` "a game: started from the call in one click, joined from its tile, rounds counted down and played, a
bonk felt on both sides", line 52, "the same leader for both":

```
Expected: "BPV2d_gpfD-…"   (Bob's view)
Received: "BIvVrh63nGb…"   (Alice's view)
```

Both views had passed the poll before it: game link open, round ≥ 1, counting down or playing, and playing it. #200
changes theme CSS only (looks the game test does not use); the cues' sleep (#205, on master) changes nothing in headless
Firefox on a runner, which never gets a running AudioContext. The same test failed at a later step in #205's gate the
same day (ticket 97), another cause.

## Readings, not told apart
- The test: the two views are read one after the other, each read of a page drawing its game in software taking a third
  of a second to over one (ticket 93), so they are not of one moment; a leader that changes hands as the second player
  comes in would show so. Then the claim wants a poll until both agree.
- The app: two apps that each lead a while, as 8811fc0 found once for the first round's countdown. Then it is a bug.

## Next
The failed try's trace (artifact `e2e-firefox-5-45966429580-1`): both views' `leader` over the seconds before line 52.
