# 47 · Flake: "The server did not answer the join request." after the socket drops mid-join

Status: shipped 2026-10-12 to nightly and prod (prod ca1a9ac, nightly e2e green first); fixed on branch flake/join-no-answer (PR #46), 2026-10-12; outcome 2 of ticket 35 (the app is wrong)
Seen 2026-10-11: preview run 38180213444, attempt 1 (PR #44, against `dave-pr-44`, real Cloudflare), job 114591116592,
Chromium shard 1: `call.spec.ts` "Chromium and Firefox in one call connect and hear each other" failed on its first try
and passed on the retry; the job was then re-run. Chris clicked Join, the Leave button never came, and the page said
"The server did not answer the join request."

## What the failed attempt shows
From its artifact (both friends' wire logs and the trace; times are the trace's, in seconds):
- 64.48 Chris's join goes up on his first socket.
- His socket closes before any answer: he opens the next one at 65.29 (the first reconnect waits 0.5 to 1 s), is let in
  at 65.63. Fiona's socket drops too, about a second after his (Firefox logs it at 65.65), and she is let in again at 66.80.
- No frame ever lists Chris as a participant: neither the presence broadcast a join causes on the old sockets nor any
  snapshot after. The server never applied the join. No `server_frame_rejected` in PostHog for that minute, so it was not
  refused either (Chris had telemetry on, ticket 30): it was lost with the socket.
- Chris never sent another join. 8 s after the click, `declareJoin` timed out and the page showed the error.

## Cause
The app. A join still waiting for its answer was tied to the socket it went out on. When that socket dropped, only a friend
already in the call declared again after the reconnect (`redeclareAfterReconnect`, which runs only once joined); a join in
flight was never asked again, and the app gave up on a server that had been back for seven seconds. The same held for a
join whose socket dropped while the microphone was opening: `room.send` refused it, nothing went out, and the error came
8 s later. A friend on a bad network meets both.

Why both sockets dropped is not known. None of the Room's own closes fits: a superseded socket shows "opened elsewhere",
a refused answer shows the refusal, the silent sweep needs 90 s. The per-IP upgrade limit only refuses new sockets. Two
sockets of one room dropping a second apart, both let in again at once, looks like the platform (a Durable Object or edge
restart); its logs are not reachable from here. The app has to survive it either way.

## Regression test
`resilience.spec.ts` "a join lost with a socket that drops is asked again on the next one, and the call starts": Alice's
`up` tamper drops her join, as the server never got Chris's, and cuts her socket the moment it passes; it comes back at
once.
- Red, on the test alone (eb7b3dc): e2e run 38219930450 and preview run 38219971687 (against `dave-pr-46`), Chromium and
  Firefox, failed on both tries, the only failing test.
- Green with the fix (01b3e65, under an earlier copy of this ticket): e2e run 38222715748 and preview run 38222722433, both engines, no test
  retried; red-green run 38222715658 ran the new test against the app from eb7b3dc and saw it fail there.

## Fix
`askServer` (client/call.ts) is `awaitReply` with an `again`: it sends the request once more and gives the server the full
8 s from then. While a join (or Rejoin) waits for its answer, each socket the server lets in gets it again, unless it
already went out there (the status effect, only while `join` runs; once in the call, the redeclare does it). The 8 s
stays: the slowest answer the Room gives to a join is one TURN mint, which it cuts off at 5 s. Found alongside: a request's timeout deleted whatever waited in its slot,
so a redeclare overtaken by a second reconnect could end the second one's wait; it now ends only its own.

## Review
Independent review of the diff before the first push of the fix: one real finding, fixed. The re-ask first ran whenever
the friend was not in the call, and a redeclare's join also counts as waiting: Leave within 8 s of a reconnect, then
another reconnect, and the stale join went out again, putting a friend who had left back in the call on the server. It
now runs only while `join` itself runs, and not on a socket the join already went out on.

## Grumpy Friend
Adversarial pass before master, three sequences. One was a real hole in the fix above, now closed red then green: Leave
did not forget a redeclare still waiting for its answer, so a reconnect while the next Join opened the microphone asked
it again, and the server had the friend in the call with her button at Join (`resilience.spec.ts` "a join asked again
after a reconnect and left unanswered is not asked once more for the next join"; Leave now clears it).

Left for Daniel, older than this ticket: switching rooms while a join waits for its answer leaves that join alive
(`joinCall` in `App.tsx` only leaves the room already in the call), so its late answer, or now its re-ask, can put the
friend in two calls; and answers are matched by kind only, so a redeclare's late answer can answer the next join and
leave `myJoinSeq` out of step with the server (who offers to whom could then disagree). The second needs a request id
in the protocol.

## Comments

2026-10-12, the two left for Daniel, both real, fixed on branch fix/followups (PR #48), shipped 2026-10-14 to nightly and prod (prod 41657fb, nightly e2e green first):
- **Two calls at once.** Alice clicks Join in Room, its answer is slow, and she joins Other meanwhile. `joinCall` left only
  `active`, a call already joined, and `leave()` did nothing for a join under way: Room's server already had her in its
  call, and its answer put her in it in this tab too, her microphone with it. `resilience.spec.ts` "joining another room's
  call while a join waits for its answer leaves that join…" holds Room's answer, joins Other, lets the answer go.
- **A late answer taken for the next join's.** In the call, a socket drop, her declaration's answer slow, Leave, Join:
  the old answer was taken for the new join's, and her join sequence was not the one the server listed.
  `resilience.spec.ts` "a late answer to a join declared again is not taken for the answer to the next join". Its first
  version passed on the old app: with nobody joining in between, both answers carried the same sequence; Bob now leaves
  and joins again between.
- Red, on the tests alone: e2e run 38267913881 (0d47f72, the first test; the second passed there, see above) and
  e2e run 38268396213 (72badca), both tests, Chromium and Firefox, failed on both tries, the only failing tests.
- Green with the fix (236a00b): ci run 38269017089, e2e run 38269017085 and preview run 38269026256 (`dave-pr-48`, its
  whole browser suite), both engines, no test retried; red-green run 38269016873 saw all four new tests (the two above,
  `call.test.ts` and `core.test.ts` on the id) fail on the app from before the branch.

Fix: `join` and `ice` carry a request id (`RequestId`, core/protocol.ts) that the server repeats in `call` and `ice`; the
client takes an answer only for the request it names. Either side takes messages without one, for the mixed fleet a
deploy leaves: an old client gets answers without an id as before, and an answer without one (an old server) goes to the
request of its kind, as before. Joining a call now leaves every other room's call, its join under way, or its Rejoin
waiting for a socket (`joinCall`, App.tsx; also when the tab steps back). A join left while under way ends without a
call (`endJoinWithoutCall`, client/call.ts): its wait ends at once, it is not asked again, the server hears Leave on the
socket the join went out on, and the microphone closes. A join the server never answered ends the same way besides the
error, since the server may have taken it and lost only its answer: before, it could list the friend in a call her
button said she was not in, her microphone open.

Review of the diff (before master, read-only): nothing real; the judgment calls are below. Grumpy Friend: two real holes
in the fix, closed red then green, and one older leak the fix now meets every time:
- A join left while its microphone was still opening (Firefox on a phone asks on every visit) stayed under way until it
  opened, so Join in that room meanwhile did nothing, and both joins ended without a call. Join there now lets it go on.
  `resilience.spec.ts` "Join in Room, then in Other, then in Room again while the microphone opens ends in Room's call".
- Leaving a Rejoin kept its marker, so a reload within 30 s put the friend back in the call she had left for another
  room's. Leaving a Rejoin, waiting for its socket or under way, now removes the marker. `resilience.spec.ts` "a Rejoin
  left for another room's call is not taken up by the next reload".
- Red, on the tests alone (1dd756f): e2e run 38271493467, both tests, Chromium and Firefox, failed on both tries. Green
  with the fix (476a38c and the head after it): see PR #48.
- Not fixed here, for the ghost and TURN leak part of PR #48 (ticket 45's leftovers): the Leave a join left under way
  sends can reach the Room during that join's TURN mint, before `turnUser` is set; the mint's patch then writes it onto a
  visitor, and nobody revokes it (`apply` in worker/room.ts only checks the socket is attached). Before this, a join
  under way was never told to leave, so this was rare; now it is the normal path when switching rooms mid-join.

Left as judgment calls: a tab taken over while a join is under way still waits out the 8 s and shows the error (the
`elsewhere` branch of the status effect leaves only when joined; `leave()` now handles a join too). An old server
answers without ids, so until a deploy reaches the Room a late answer can still be taken for a newer join, as before.

2026-10-12, the TURN leak above, fixed on branch fix/followups (PR #48), shipped 2026-10-14 to nightly and prod (prod 41657fb, nightly e2e green first): a join's TURN user is minted after the join is
stored, so a Leave (now sent by every join left under way), a close or a supersede during the mint found no user to
revoke, and the mint's patch then wrote it onto a visitor or a dead socket, or dropped it. A mint now keeps its user only
if the socket is still in the join it was minted for; otherwise it is revoked at once and its answer is not sent, so a
client from before request ids cannot take it for its next join. The client's Leave also stops waiting for an ice
answer. `test/turn.test.ts` "a TURN user minted for a join the socket has left meanwhile…", red in ci.yml runs
38302854786 and 38307993393. The rest (what becomes of the users of a socket that goes) is in ticket 45's comments.
