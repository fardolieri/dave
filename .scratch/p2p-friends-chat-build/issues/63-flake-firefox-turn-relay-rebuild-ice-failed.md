# 63 · Flake: Firefox's rebuild over the TURN relay failed ICE against nightly, and Bob never heard Alice

Status: fixed on branch flake/turn-relay-rebuild, 2026-10-27 (an app bug, Firefox); seen twice
Seen 2026-10-25: the nightly e2e run of 3c5faba (40239237252), Firefox, shard 5, passed on its retry, so the gate went red:
`resilience.spec.ts:556` "after a stalled attempt the rebuild goes through the TURN relay, and both sides take it (ticket
22)". `Error: Bob hears Alice`, and in Alice's console `WebRTC: ICE failed, see about:webrtc for more details`.

Not the commit (the first use of `/release` step 2a): 3c5faba adds an info line on a room socket's welcome and excuses the
browser's socket errors the app recovered from (ticket 60); nothing on the call or ICE. Not seen in the month of gate runs
before (none of the 22 red ones). The relay path exists only against a deployed copy (Cloudflare TURN), never on a local
build, so the branch's own runs could not have shown it. The next master commit, 6721f4f, passed the gate.

Seen before, 2026-10-21: the preview run of PR #89 (39566936449), Firefox, shard 5, the same test and the same error.

## What the two traces show (2026-10-27)
The same in both. The relay-only rebuild (Alice's offer, new ICE credentials) failed ICE about 5 s later in Alice's
Firefox, the app restarted ICE on that connection (`connectionFailed`, a third offer, new credentials again), and the
restart connected through the relay on both sides: both badges "via relay", 3 ms round trip. Alice had about 165 KB of
Bob's voice; Bob had 0 bytes of Alice's. One-way audio on a connection that reads healthy.

## Reproduced
A test that keeps Bob's candidates from Alice until her relay-only rebuild fails, then lets them through
(`resilience.spec.ts`, "a relay-only rebuild whose ICE failed comes back with voice both ways"), dispatched against
nightly 8 times per engine (run 40581367187): Firefox failed every try on "Bob hears Alice", as in the sightings. Chromium
never fails ICE without a remote candidate (it stays "new"), so the test runs in Firefox only.

## Cause and fix
An ICE restart of a connection that never connected, in Firefox. The app's tracks are on the senders (`attachLocalTracks`
at the rebuild), and a fresh relay-only connection carries voice both ways (the test above it), so it is the restart. The
browser's own cause is not known. Fix: a connection that never connected is rebuilt, never restarted, after a back-off
of its own (`failedRebuilds`, `failedRebuildDelay`), on a failure and on a disconnect that outlasts its grace, on either
side; one that had connected is still restarted. The rebuild keeps the connection's policy: only the stuck-connecting
watchdog turns to the relay (ticket 22), so a first attempt over every path that failed once keeps them all. It reports
`peer_never_connected`, and the dev hook's `peers()` counts each connection's ICE restarts, which the test checks are 0.

Left open: whether Firefox also loses the voice when a connection that had connected is restarted; nothing has shown it.
A review pointed at one way it could: a restart offer that reaches a side whose ICE already failed is answered from a
fresh connection (`onSignalNow`), so an old connection, renegotiated, meets a new one. For a side that never connected
this no longer happens: an offer to it while its rebuild waits, or one that restarts its ICE, is dropped and it rebuilds
at once (the Grumpy Friend's sequences: a handshake through on one side only, a renegotiation meanwhile, a friend still
on the app from before).

## Questions (as opened)
Did the relay candidates gather at all on Alice's side (the `relay_candidate_gathered` event, `peer_connecting_slow` with its
counts)? Ticket 22's TURN credentials: fetched fresh for the rebuild, or expired? The failed try's trace is in the run's
`e2e-flaky-firefox-5-40239237252-1` artifact (14 days). From now on its sightings are counted in the flake ledger.
