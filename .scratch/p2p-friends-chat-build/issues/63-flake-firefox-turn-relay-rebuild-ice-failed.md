# 63 · Flake: Firefox's rebuild over the TURN relay failed ICE against nightly, and Bob never heard Alice

Status: open, not looked into; seen once
Seen 2026-10-25: the nightly e2e run of 3c5faba (40239237252), Firefox, shard 5, passed on its retry, so the gate went red:
`resilience.spec.ts:556` "after a stalled attempt the rebuild goes through the TURN relay, and both sides take it (ticket
22)". `Error: Bob hears Alice`, and in Alice's console `WebRTC: ICE failed, see about:webrtc for more details`.

Not the commit (the first use of `/release` step 2a): 3c5faba adds an info line on a room socket's welcome and excuses the
browser's socket errors the app recovered from (ticket 60); nothing on the call or ICE. Not seen in the month of gate runs
before (none of the 22 red ones). The relay path exists only against a deployed copy (Cloudflare TURN), never on a local
build, so the branch's own runs could not have shown it. The next master commit, 6721f4f, passed the gate.

## Questions
Did the relay candidates gather at all on Alice's side (the `relay_candidate_gathered` event, `peer_connecting_slow` with its
counts)? Ticket 22's TURN credentials: fetched fresh for the rebuild, or expired? The failed try's trace is in the run's
`e2e-flaky-firefox-5-40239237252-1` artifact (14 days). From now on its sightings are counted in the flake ledger.
