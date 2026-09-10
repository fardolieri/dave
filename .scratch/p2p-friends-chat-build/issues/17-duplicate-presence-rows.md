# 17 · The same friend listed twice in the call list

Status: resolved
Reported 2026-09-10 20:2x UTC by Daniel with a screenshot of the live room: "Ratchez" twice in the Call list, both "direct", no fingerprints. A visitor probe of the live room read the hover titles: the friend's identity (fingerprint 5rwpz6) listed twice, and Daniel's own (ftxtzw) listed twice as well; Daniel saw himself once only because the list renders a single "you" row.

## What happened
PostHog shows `server_socket_closed` with code 1006 for both tabs at the same second three times (20:12:51 with the deploy, 20:18:15, 20:22:17), each followed by `server_reconnected` and `peer_server_lost`. The clients reconnected; the Room still held the old sockets as attached. `supersede` closed them and left them out of that one broadcast only. A dead socket stays in `getWebSockets()` until the runtime finishes the close handshake, which for a peer that is already gone may be never, so every later broadcast (a join, a share, a rename) listed it again. The silent sweep hit the same wall: `close()` on a dead socket does not remove it.

## Fix
- `core/room.ts`: `presenceSnapshot` lists one person per identity, from the socket with the newest `attachedAt`. New `SocketState` stage `closing`: a socket told to go is invisible to presence, fan-out and delivery, and anything it still says is ignored.
- `worker/room.ts`: `supersede` and the silent sweep mark a socket `closing` before `close()`.
- Tests: `presenceSnapshot` dedupe (core), and a second socket for the same identity superseding the first with later snapshots listing the identity once (presence).

## Open
- Why three simultaneous 1006 drops in ten minutes. The first coincides with the deploy; the other two do not. Worth a look at the Worker's observability logs for Durable Object resets or exceptions.
