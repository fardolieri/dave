# 45 · Flake: the worker tests on nightly, a timed-out rate-limit loop and a presence nobody asked for

Status: shipped 2026-10-12 to nightly and prod (prod ca1a9ac, nightly e2e green first); fixed on branch flake/worker-test-nightly (PR #45), 2026-10-12; outcome 1 of ticket 35 (the test is wrong) and
outcome 2 (the app), one each
Seen 2026-10-11: ci.yml run 38176731497 (commit ac8fb94, branch flake/text-reload, an e2e-only change), job
114580584837, `check (nightly)` only; `check (prod)` of the same run passed. In `test/worker.test.ts`, "rate-limits
upgrade attempts per IP" timed out at 5 s, and "after authentication a second auth is refused" got
`{ t: 'presence', people: [Dave] }` where it expected the "already authenticated" error. Both passed on later commits.

## Cause
Two, the first setting off the second.

The rate-limit test went through the Worker until it saw a 429: on nightly's limit of 120 (ci.yml and deploy.yml run the
tests with CLOUDFLARE_ENV=nightly; prod's limit is 10) that is 121 upgrades, each opening a socket in a real Room. In the
25 nightly checks before this one it took 0.8 to 4.1 s (median about 1.1 s), slower when other test files load the
runner; none of the slow ones crossed a minute boundary, so this is not the rollover that 1b11360 fixed. This time it
passed 5 s. Vitest's timeout fails a test but does not stop it: the loop went on in the background, opening and closing
sockets in `gate-test-room`, the room the gate tests share (the next three tests took 0.7 to 1.7 s instead of tens of
ms). It was probably still at it when the last gate test ran: the file ended at 21:32:01, and the minute rolled over
at 21:32:00 and gave the loop a fresh window to fill. The run kept no trace that says so for sure.

The Room sent a presence snapshot to everyone in the room whenever any socket closed or errored (`webSocketClose`,
`webSocketError`), also a socket that never got past its challenge and so was never in presence. Each of the loop's
sockets, and the unauthenticated sockets earlier gate tests close, made the Room send Dave a snapshot that said nothing
new; the test, which skipped exactly one snapshot after its welcome, read one of those as the reply to its second auth.
In the field: a snapshot to every friend in the room for every handshake that does not finish (a stranger at the gate,
a client that drops before answering). Harmless to the client, which takes snapshots as they come, but noise.

## Regression test
`worker.test.ts` "a socket that leaves without ever authenticating sends no presence to the people in the room": Dave is
in a fresh room, five strangers take their challenge and close, then Dave's second auth brings an error he is sure to
get after anything the closes made the Room send. He must have heard only challenge, welcome, presence, error.
- Red, on the test alone (23a64d4): ci.yml run 38219225287, both `check (prod)` and `check (nightly)`: nine frames,
  the five extra snapshots.
- Green with the fix (20756e7): ci.yml run 38221092172, both envs; `worker.test.ts` took 446 ms on nightly, 357 ms on
  prod. red-green run 38221092254 ran the new test against the old app and saw it fail there. e2e run 38221092138 and the
  preview run 38221098830 (`dave-pr-45`, with its browser suite) passed, both engines, nothing flaky.

## Fix
- The app (4189839, "Problem report:"): `webSocketClose` and `webSocketError` broadcast presence only for a socket that
  was attached. A socket marked `closing` (superseded, or dropped by the sweep) was taken out of presence, and the
  snapshot sent, when it was marked; a challenge never was in it. The TURN revoke on close is unchanged (attached only).
- The tests (20756e7): the rate-limit test uses up the address's attempts on the `UPGRADE_LIMIT` binding itself, which
  the Worker asks with the same key, then makes one attempt through the Worker and expects 429; in a room of its own.
  A window rolling over between the two counts from zero, so the test goes round again, at most three times: a rollover
  happens once a minute, so the second round never meets one. No sockets in a loop, no Room per attempt, a few ms on any
  limit. "after authentication a second auth is refused" waits for its error past any snapshot: friends of earlier tests
  leaving the shared room send real ones.

## Left as it is
Vitest does not stop a timed-out test, so any test that loops on the Room can still leak into the next ones if it
overruns. None does now.

Found by the review, older than this ticket and not its business: the sweep marks a silent attached socket `closing`
without revoking its TURN credentials (`alarm` in `worker/room.ts`), and `webSocketClose` only revokes for an attached
socket, so a swept participant's TURN user is never revoked; supersede does revoke. Needs its own ticket.

Found by the Grumpy Friend pass before master, also older than this ticket: `webSocketError` on an attached socket
neither marks it `closing` nor revokes its TURN user, so an errored socket the runtime has not let go of yet can show up
again in later snapshots (a ghost) until the close or the sweep comes; and a TURN user minted during a join leaks when
the socket closes or is superseded while the mint is under way. Both need their own ticket. The same pass added
`call.test.ts` "a socket the sweep drops leaves the presence of those still there, from the sweep itself": since the
close the runtime reports later now broadcasts nothing for a closing socket, the sweep's own snapshot is the only one.

## Comments

2026-10-12, the two leftovers above, fixed on branch fix/followups (PR #48), red then green:
- **Ghost presence.** `webSocketError` broadcast a snapshot without the socket but left its attachment attached; the
  runtime can keep an errored socket in `getWebSockets()` until its close or the sweep, so the next snapshot (someone
  joining or muting) listed the friend again. An errored socket is now marked closing and closed (4005, which the client
  takes like any drop: it reconnects). `presence.test.ts` "a socket that errored stays out of presence, also in the
  snapshot of the next friend who comes in". Red: ci.yml run 38294584234, both envs (Carol's snapshot had Alice in it).
- **TURN users.** The rule now: a TURN user is revoked only when its friend leaves the call (her Leave revokes every
  user she holds, those carried from earlier sockets too); otherwise it runs out after 12 h (ICE_TTL_SECONDS). A socket
  that goes (close, supersede, sweep, error) leaves its users in storage under her public key (`away:<key>`,
  `{ users, since }`), her next join takes them over, and the sweep forgets entries older than the TTL without revoking
  them. Her peer connections can outlive the socket (ticket 31), and media can flow with every socket gone (two phones
  talking with their screens off are both swept), which the server cannot see; revoking under them drops a relayed call
  at the allocation's next refresh. Before, close and supersede revoked at once (that dropped calls), and the sweep and
  an error revoked nothing. A mint that comes back after its socket left the join it was for (a Leave, a Join again,
  closed, superseded) is revoked at once and its answer not sent, STUN only or not (`settleTurnUser`; a `joins` count per
  socket, since a Leave and a Join can give the same join sequence). `test/turn.test.ts`, Cloudflare's TURN API mocked.
  Red, ci.yml, both envs: runs 38302854786 (nine tests), 38307993393 (four), 38313724153 (five).
  On the way, two rules were tried and dropped before master after the Grumpy Friend and the review: a 30 min grace
  after a socket goes (a phone in a pocket on a longer call dropped), then "revoke once the sweep finds nobody in the
  call" (two swept phones still talking dropped).
- **What the rule costs**, known and left: the users of a friend who never says Leave (closes the tab, loses the
  network for good) stay valid up to 12 h. An ice refresh or a Join again in the call adds a user rather than replacing
  one; all are revoked at Leave, but at most 16 are kept per friend (an attachment holds 16 KB), so on very flaky Wi-Fi
  the oldest is let go to run out. A deploy drops sockets, probably without `webSocketClose` (unconfirmed): a mint under
  way then runs out at 12 h. Attachments from before the deploy with the old single `turnUser` are not read; a deploy
  drops those sockets anyway. `away:` entries live in a room's storage until a sweep after their TTL, and a room nobody
  visits again keeps them (a few hundred bytes per friend).
- The rate-limit test timed out at 5 s again on nightly (ci.yml run 38298003264, a branch that does not touch the gate).
  Likely cause, not proven (no timings were kept): in Miniflare each of nightly's 121 attempts is a round trip to the
  limiter's own Durable Object and a write there, one after the other. They now go 40 at a time.
