# 57 · Flakes: a Join click beside the button, and a reader's socket dropped under a text sent again

Status: fixed on branch flakes/nightly-resilience, 2026-10-16; outcome 1 of ticket 35 (the tests are wrong) for both
Seen 2026-10-16: the nightly e2e run 38862111516 of e02aaa7 (attachments), both passed on the retry, which closed the gate:
- job 116846518050 (Firefox, shard 4): `resilience.spec.ts:246` "a friend whose socket drops without a goodbye…", Alice's
  `join()` never saw the Leave button.
- job 116846518153 (Chromium, shard 5): `resilience.spec.ts:678` "a socket gone silent without a close…", Bob never got
  "into the silence" in 150 s.
Neither had failed before in the 54 e2e runs scanned (every e2e.yml run back to 2026-10-13, both engines).

## Cause
- Join: no `join` frame went up, nor the `mute` the join declares first, so the app never ran its join. The trace has the
  click performed between 58452 and 58504 ms, and Bob's presence, his row in Alice's Online list, came down at 58498 ms.
  The row moves everything below it about 34 px, the Join button too, and the click landed on "nobody in the call".
  The microphone was not involved.
- Silent socket: Alice did all the test asks of her (gave the socket up with 4009, sent the text again, the Room took it
  once and it came back to her). Bob's own socket ended with 1006 from below 0.6 s after Alice's new one was let in,
  ticket 51's drop, and the Room keeps no texts, so the broadcast went into his dead socket. The test promised Bob the
  text, which the app cannot hold when the reader's socket drops.

## Fix (the tests)
- `crowd.open` returns once every friend connected in the room lists the newcomer: no test acts while rows still come in.
- The silent-socket test checks Alice's side first (4009, the text back and no longer waiting), then Bob's: the text once,
  or, after a drop his wire saw (`droppedSince`), once or not at all, as ticket 53 did for two text tests.

## The drop itself (diagnostic, 2026-10-16)
Branch diag/socket-drops (kept until the owner decides, not for master): `e2e/diag-drop.spec.ts` puts three observer
sockets in one room, Alice through Playwright's proxy, Dora in a page without it, and one from Node with no browser, while
Bob comes in again every few seconds; a CI job tails the Worker meanwhile. Drops of an observer, per round of Bob's:
| Target and variant | Rounds | Drops of observers |
|---|---|---|
| local build (workerd, no Cloudflare), rooms of 1.7 min | 960 | none |
| local build, idle 20 to 75 s between rounds, and with Bob's old socket left dangling | 288 | none |
| nightly, rooms of 1.7 min | 960 | none |
| nightly, rooms of 8 min (`steady`, 2 s between rounds) | 5600 | 6 (8 sockets), every one during Bob's reconnect |
| nightly, idle 20 to 75 s between rounds, and with Bob's old socket left dangling | 432 | 5 |
| nightly, Bob in a room of his own (`elsewhere`) | 2240 | none |
| preview `dave-pr-66`, a Room without the hibernation API (`steady`) | 2240 | one event: every socket of 8 rooms, within 1.6 s |
- Not the proxy, not a browser: the Node socket drops as often as the others.
- Not our Room code: none on the local build. The Room never hears of a drop: the tail shows no close and no end of the
  upgrade for the dropped socket, only for others (so frames it sends there meanwhile are lost).
- Without hibernation, one Cloudflare event cut every socket of eight rooms at once: a restart of what runs them. With
  the hibernation API, which the Room uses, sockets are meant to outlive such a restart, and nearly all do; what is left is
  a single socket now and then, mostly when the room gets a request (a friend connecting) around it.
- So: a platform event, not ours, at about one drop per socket-hour (ticket 54's field rate), that the app can only make
  harmless. Hibernation stays: without it every drop takes the whole room.

## Left as it is
- The same jump of the Join button can meet a real friend's thumb when someone comes online. A layout question for the
  owner, not changed here.
- Making the drop harmless (the Room replaying what a friend missed while her socket was cut, or texts stored on the Room)
  is the owner's call: ticket 10 of quality declined server-side catch-up before this was known.
