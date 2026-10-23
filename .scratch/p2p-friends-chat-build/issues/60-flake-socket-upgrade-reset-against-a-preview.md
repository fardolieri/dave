# 60 · Flake: a socket's upgrade reset against a preview fails a test on its console line alone

Status: open
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
