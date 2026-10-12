# 47 · Flake: "The server did not answer the join request." after the socket drops mid-join

Status: fixed on branch flake/join-no-answer (PR #46), 2026-10-12; outcome 2 of ticket 35 (the app is wrong)
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
