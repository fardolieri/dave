# 53 · Flake: two text tests failed on a socket the network dropped, not on the new text outbox

Status: fixed on branch flake/text-firefox-preview, 2026-10-14; outcome 1 of ticket 35 (the test is wrong); the drop
itself is ticket 51's, still unexplained
Seen 2026-10-14: the preview run of PR #52 (38593882197, head aa0311d, against `dave-pr-52`), Firefox, both passed on the
retry:
- job 115957015424 (shard 7): `text.spec.ts:15` "texts in a row from one writer go under one name", Alice's composer
  still held "one" after 20 s (`toHaveValue("")` in `say`).
- job 115957015473 (shard 8): `text.spec.ts:214` "the chat keeps its place when the share strip comes and goes", Bob
  showed 23 of Alice's 24 filler lines.

Suspected first: the text outbox of 1b828cb and 41657fb (ticket 51), landed on master the same day. Not it.

## Cause
Both are the drop of ticket 51: a socket that was let in ends with 1006 from below, and the friend is back on a new one a
second or two later. From the artifacts (wire logs, trace):
- Shard 7: Alice's socket dropped after 5 frames, 110 ms after Bob was let in (as ticket 51 saw: "mostly within a second
  or two of another socket of the room connecting"). In the trace, `say` filled "one" at 9996 ms, Firefox logged "The
  connection ... was interrupted" at 10016, Enter came at 10029. The composer, disabled while disconnected, sent nothing and
  kept the text, as it should (`Composer` in App.tsx; "the composer refuses to send while the server is unreachable" pins
  it). No text frame went up on either socket, so the outbox never had it. After the reconnect the composer showed "one"
  for the remaining 18 s: a friend would press Enter again, `say` never did.
- Shard 8: Bob's socket dropped (1006, 36 frames) right after "filler line 22" came down; Alice's "filler line 23" came
  back to her, and never to Bob. The Room still took the dead socket for his: what it sent into it is gone (ticket 51,
  "Left as it is": the Room keeps none). The outbox only re-sends a writer's own texts, so it cannot help a reader.
The two drops are 76 s apart, on two runners, against the same preview.

## How often, before and after 1b828cb
- History (every nightly, dispatch and preview e2e run since 2026-10-04 with these tests, 99 runs, both engines): before
  1b828cb, "texts in a row" failed 0 of 346 first tries, "share strip" 1 of 349 (the 8eccf87 preview run 38308000624,
  Chromium, which ticket 51 traced to the same drop); after, 1 of 53 and 1 of 54, both in run 38593882197.
- Repeat now: e2e run 38595485263 against nightly (aa0311d), both titles, `--repeat-each 20`, both engines: 80 of 80 on
  the first try.
Both failures fell in one run, on two runners, in the same two minutes; nothing says the outbox made drops more likely,
and its code is not on the path of either failure (no text was in the outbox in the first, the lost line was a reader's).

## Fix (the tests)
- `say` (fixtures.ts) presses Enter again when the composer still holds its text once enabled again, and only after a drop
  the wire saw (`Wire.droppedSince`: a close from the server side with 1006, from 2 s before the call on, since the wire
  hears of a drop a moment before the page does). A text still in the enabled composer then is one that was never sent;
  without a drop the fixture is as strict as before.
- The share-strip test, when Bob's socket dropped during the fillers, waits for him to be back, then has Alice send more
  lines until he holds 24, each seen by him before the next: the test is about the scroll position, not delivery, and no
  filler is still on its way when he starts reading.

## Evidence
Diagnostic branch diag/flake53-drops (deleted): `e2e/diag-drop.spec.ts` plays both drops with the wire (a close recorded as
the network's 1006): Alice's socket closed right after the fill, Bob's last filler line dropped on the way down and his
socket closed after it. Against a local build, both engines:
- Red, on master's fixtures (698d829): e2e run 38599675710, the `say` case failed in both tries in both engines exactly as
  job 115957015424 did (`toHaveValue("")`, received "one").
- Green with the fix (4b1418b): e2e run 38600856181, the whole suite and both cases, every test on its first try.

## Left as it is
- The drop itself (ticket 51): where it happens is still not known.
- A text others send while a friend's socket is down still misses her. A test that counts a reader's lines can still fail
  on a drop; these two no longer do.
- An Enter pressed in the second or two of a reconnect is lost, and the text waits in the composer. Since ticket 51 the app
  keeps a text until the Room has it and sends it again on the next socket, so the composer could take a text while
  reconnecting and queue it; that is a product choice (PR #1 is about the same), not made here.

## Raised by the review, not checked here (for ticket 51's outbox, owner's call)
The adversarial review read three gaps in the app, none run: a text still out is kept in memory only, so a reload or a
discarded tab loses it without a word; a reader who reloads before the writer sends a text again sees it twice, in his
history too (the id filter is not refilled from history, and the Room stamps each send with a new time); a socket that
goes silent without closing is not noticed (the ping's answer is not awaited), and `Wire.droppedSince` cannot see one.
