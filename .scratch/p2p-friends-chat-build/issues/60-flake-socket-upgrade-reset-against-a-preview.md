# 60 · Flake: a socket's upgrade reset against a preview fails a test on its console line alone

Status: fixed in 3c5faba, shipped 2026-10-26 to prod (the test is wrong, outcome 1 of ticket 35); where the reset
comes from is still not known
Seen 2026-10-21: the preview run of PR #89 (head 29121e1, against `dave-pr-89`), Chromium, shard 5, passed on the retry:
`resilience.spec.ts:441` "an offer stuck for a friend who then reloads leaves their new connection alone (the impolite side
reloads, the first to join)". The test itself went through; the fixture's console check failed on one line of Alice's:
"WebSocket connection to 'wss://dave-pr-89…/ws/…' failed: Error during WebSocket handshake: net::ERR_CONNECTION_RESET".

## What is known
The connection was reset during the upgrade of a room socket, at Cloudflare's edge or on the way to it: nothing of the
app's ran on it. The app gives such a socket up and opens the next one (client/room.ts, `lost`), which is what happened:
the test's steps all passed. Chromium logs the failed upgrade itself, as an error, and the fixture fails a test on any
console error nobody expected. Ticket 58 is the same kind of reset under the app's script on first load, which the app
now survives by reloading once; there the console line is expected by the one test that provokes it.

## Question
Either accept this console line as harmless in runs against a deployed copy (previews, nightly), since the app recovers
from it by design and nothing the app does causes it, or find whether the reset comes from the Room (a Durable Object
evicted mid-upgrade, say) and not the network. The second would show up in Workers observability as a socket that never
reached `webSocketMessage`; the trace of this run has the wire log of both friends.

## Answer (decided with Daniel, 2026-10-26)
Neither of the two: if the app got over an error, the test should pass, but only then. Not an allowlist, which would also
let through a socket the app never recovered from. The app logs `[recovered] room <id>: let in after <n> lost sockets`
(info) when a room is let in again after lost sockets (client/room.ts), and the fixture excuses the browser's error for a
room socket it could not open only when that room's recovery comes after it (e2e/console.ts). Regression test:
`resilience.spec.ts` "a socket the browser could not open, tried again until one gets in, …", the browser offline while
the app reconnects; Chromium logs the same line for each failed attempt.
