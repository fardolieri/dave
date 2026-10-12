# 49 · Flake: the unread test sent its text before the friend was in that room

Status: fixed on branch fix/followups (PR #48), 2026-10-12; outcome 1 of ticket 35 (the test is wrong)
Seen 2026-10-12: the preview run of PR #44 (38220103571, against `dave-pr-44`), job 114714189805, Firefox shard 7:
`text.spec.ts` "a text in a room not on screen counts as unread and chimes; own texts never chime" failed on its first
try and passed on the retry. Alice's "Other" never showed an unread count in 20 s.

## Cause
Not the app. Alice is in two rooms, Room on screen and Other behind it; Bob only in Other. `crowd.open` waits until the
room on screen is connected, not every room. Bob said "psst" as soon as he was in. A text goes to the sockets in the
room as it is sent; the server keeps none for later. From the artifact (wire logs and trace, seconds of the trace):
- 48.20 both of Alice's sockets are routed to the server; Room lets her in at 49.15.
- 50.30 Bob's "psst" goes up, 50.33 it comes back to him.
- 50.56 Alice's socket to Other gets its challenge, she is let in at about 50.58: 0.25 s after "psst" had gone round.
Her socket to Other took 2.3 s to get its challenge, Bob's (opened later) 0.3 s. Why is not known; a background room
being slower to connect than the one on screen is nothing the app promises against.

## Regression test
The test itself, with Alice's way into Other slow: her answer to Other's challenge goes out 6 s late (the server allows
10). The `up` tamper tells it apart by the room's verifier, which a first answer to a fresh room carries.
- Red, on the test alone (e3e838d): e2e run 38278217447 and preview run 38278222934 (against `dave-pr-48`), Chromium
  and Firefox, both tries, at the unread count; the only failing test.
- Green with the fix (1b190a9): e2e run 38280396162 and preview run 38280405684, both engines, no test retried.

## Fix
Bob speaks once Alice shows in his online list for Other. No app change, so the fix commit is not a "Problem report:".
