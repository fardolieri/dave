# 79 · Flake: once, Firefox logged "ICE failed" for Alice while the test held her links

Status: open; the cause is likely known, not confirmed
Type: flake

Seen 2026-11-10: the preview run of #134 at e74bb3e (run 42857212958), Firefox, shard 2, passed on its retry.
`attachment.spec.ts:709` "a picture that could not be pulled while its sender was briefly away comes by itself once she
answers" (attachments ticket 05). #134 changes only the own profile card (markup, CSS, one presence test), nothing on
this test's path.

```
Error: console warnings, errors or exceptions nobody expected
+   "Alice: error: [JavaScript Error: \"WebRTC: ICE failed, see about:webrtc for more details\"]",
```

## Likely cause
The test holds every `link` frame sent down to Alice until Bob shows "Couldn't reach Alice", then delivers them all at
once. A connection one of those frames belonged to can time out meanwhile, or be answered late, and Firefox logs ICE
failed for it, as it does in the other tests that stall signalling and say they expect it (`invariants.spec.ts:70`,
`adversary.spec.ts:21`, `resilience.spec.ts:609`). This test does not, so it fails only when the timing makes Firefox
give up on one.

## Next
The failed try's trace (artifact for run 42857212958, attempt 1, Firefox shard 2): which connection's ICE failed, and
whether it is one whose frames were held. If so, `alice.expectWarning(/ICE failed/)` in the test, with a comment saying
why; if not, the app left a connection behind that it should have closed.
