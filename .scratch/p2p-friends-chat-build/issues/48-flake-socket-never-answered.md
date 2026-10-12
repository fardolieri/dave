# 48 · Flake: a socket that heard nothing left the room on "Connecting…" for good

Status: fixed on branch fix/followups (PR #48), 2026-10-12; outcome 2 of ticket 35 (the app is wrong)
Seen 2026-10-12: the nightly e2e run for df3a61a (38219476267), job 114711989697, Chromium shard 6: `share.spec.ts`
"regression: a share stopped and started again goes live for its viewer, not stuck on Opening" failed on its first try
and passed on the retry. The title misleads: it never got to a share. The first friend's open failed: Alice's composer
stayed disabled for 20 s, "Connecting…" at the top.

Not ticket 46 (a share's slow start): no share had begun. The same run's Firefox failure (shard 2) was ticket 46's
share_opening test, fixed on master after that commit.

## What the failed attempt shows
From its artifact (trace, wire log, screenshot):
- Alice's page loaded in 6 s (the first visit to nightly, the service worker installing beside it); the app opened one
  socket right after, and Playwright's route connected it to the server.
- In the 20 s after, the wire saw no frame either way: no challenge, nothing from Alice. The Room sends its challenge
  with the upgrade itself (`Room.fetch`), so either the upgrade never completed or nothing came over it.
- No close came either: the status stayed `connecting` (a close would have shown "Reconnecting…").

Where it hung (the edge, the Durable Object, the runner's network) is not known; nightly's logs are not reachable from
here. What is known is that nothing in the app ever ended that wait. `client/room.ts` reconnects only on a close, pings
only after an open, and ignores whether a pong comes. A browser gives a hung handshake minutes, if anything.

## Cause
The app: a socket the server never lets in waits forever. A friend on a flaky network, or with the edge hiccuping as
here, sits on "Connecting…" until a reload.

## Regression test
`resilience.spec.ts` "a socket the server never answers is given up and tried again, and the room connects": the wire
(`Wire.unanswered`, e2e/fixtures.ts) leaves Alice's first socket open and unanswered, never connected to the server.
- Red, on the test alone (4dbae78): e2e run 38275236391 and preview run 38275244598 (against `dave-pr-48`), Chromium
  and Firefox, both tries, at `connected()` after 20 s; the only failing test.
- Green with the fix (0515666, pushed with ticket 49's red test as e3e838d, then 1b190a9): e2e runs 38278217447 and
  38280396162, preview runs 38278222934 and 38280405684, both engines, the new test on its first try. The red-green
  run 38280396235 ran it against the app from before the branch and saw it fail there.

## Fix
A socket not let in (no welcome) 10 s after it was made is given up: its handlers are dropped, it is closed, and it goes
the reconnect path at once with its backoff, without waiting for a close event that may come late or never. 10 s is what
the server gives an answer to its challenge (`CHALLENGE_TIMEOUT_MS`); signing takes milliseconds. Reported to PostHog as
`server_socket_closed` with code 4008. A socket closed by the server, refused or superseded is handled as before.

## Left as it is
A socket that was let in and then goes silent (a half-open connection) is still noticed only when the browser notices
it; the app does not watch its pongs. Not seen in a test so far. A network on which every handshake takes over 10 s
never connects now; before it did, eventually. Not seen to exist.
