# 46 · Flake: the share_opening test checked a share's frames before a slow share had sent 20 KB

Status: fixed on branch flake/share-tile-opening (PR #47), 2026-10-12; outcome 1 of ticket 35 (the test is wrong)
Seen 2026-10-11: the preview run of d770a63 (38178624935, against `dave-pr-44`), job 114586445816, Firefox:
`invariants.spec.ts` "a share tile left on "Opening…" while its video decodes is reported" failed on its first try and
passed on the retry, `bob.receivingShareFrom('Alice')` false at line 31 (ticket 44's comments).

## Cause
Not the app. The tile on "Opening…" in that test is the test's own: `holdOpening` keeps it there on purpose. Before it,
`watchShare` had seen the tile live and the picture (`videoWidth` > 0) half a second after Bob's click. Line 31 then
checked once that more than 20 KB of share video arrived in the next 3 s. It did not: 16 789 bytes.

`receivingShareFrom` reads `videoBytesIn`, which the call refreshes every 2 s. In the trace, the refresh before the check
came just before the share's first frame (0 bytes), the next one about 1.9 s into the share (16 789 bytes), the one after
that only after the check ended. So the check saw the share's first 1.9 s, at about 70 kbps; a share runs at megabits.

Why so slow: Chromium's bandwidth estimate. Diagnostic runs (branch diag/share-opening-46, not merged), Alice in Chromium
sharing to Bob, read from the click:
- e2e run 38219252208, local build, 16 runs per engine: the share's first 2 s carried 58 to 106 KB every time.
- e2e run 38220821982, against nightly, the same: Chromium viewers every time; Firefox viewers in 3 of 16 runs only 11 to
  33 KB in the first 2 to 2.8 s, then megabits.
- e2e run 38221831262, against nightly, both browsers' WebRTC stats every 250 ms: in 3 of 16 Firefox runs Alice's
  sender kept `targetBitrate` at 30 to 75 kbps and 2 to 5 frames a second for about 2.3 s, with
  `availableOutgoingBitrate` at about 210 kbps growing slowly, then doubled it every 300 ms up to 5 Mbps. No loss, no
  PLI, no NACK, `qualityLimitationReason` none, the app's encoding as it should be (active, 6 Mbps, scale 1). In the
  other runs the estimate was at 1 Mbps already 0.5 s into the share. That is the sender's own congestion control,
  seen only with a Firefox viewer and a deployed copy: not something the app sets.

With a slow start, the one check fails when only one 2 s refresh falls inside its 3 s, before the ramp: often enough to
show up once in a preview run.

## Regression test
The share_opening test's sharer starts slowly every time: `slowShareStart` (fixtures.ts) holds her share video to 1
frame a second at a quarter of the size and 30 kbps for its first 4 s after Bob asks for it, then lets it go as the app
set it, as Chromium's estimate does.
- Red, on the test alone (b66548b): e2e run 38223831681 and the preview run 38224047668 (against `dave-pr-47`), both
  engines, both attempts, at the frames check; every other test passed.
- Green with the fix (2ccd44c): e2e run 38228273939 and the preview run 38228279765, both engines, every test on its
  first try (the test took 17 to 21 s).

From review: the hold's release no longer undoes a newer setting the app made after the hold ended, and it stops
retrying once the sender is closed (only a collision with the app's own call is retried). Neither can happen in this
test, which has one viewer.

## Fix
The check asks until the frames flow (`expect.poll`), as every other caller of `receivingShareFrom` already does. The
cause is known: a share's first seconds may carry little. No app change, so the fix is not a "Problem report:" and the
red-green job has nothing to judge: the red receipts are the runs above.

## Left as it is
A friend whose share starts slowly sees a blurred, slow picture for about 2 s. That is WebRTC's estimate starting low;
the app could only work around it (raising the start bitrate is not in the API). Not seen to matter to anyone.
`receivingShareFrom` still reads the call's 2 s counter: fine for a poll, coarse for a single 3 s check.
