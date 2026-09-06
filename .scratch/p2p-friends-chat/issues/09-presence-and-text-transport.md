# Presence and ephemeral text transport model

Type: grilling
Status: resolved
Blocked by: 07

## Question

How do presence and text actually move? Visitors have no peer connections, so text between a visitor and a participant cannot ride a data channel unless visitors also join a data-only mesh. Decide: whether the server relays text or visitors form data channels; who is authoritative for "a call exists" and "who is in it"; how presence updates propagate and how stale entries are expired; what state the server holds and for how long (ideally nothing durable); and what a client shows during reconnection to the server while its peer connections are still alive.

Settled upstream in [Signaling and media stack decision](07-signaling-and-media-stack.md): there is a single server WebSocket per client carrying signaling, presence, text, and in-call control; the server assigns join sequence numbers; no data channels.

Settled upstream in [Hosting platform, server runtime, and TURN provider decision](08-hosting-and-runtime.md): the hub is one Durable Object per Room using WebSocket Hibernation, so the server may hold no state that cannot be rebuilt from attached sockets and their 16 KB attachments; per-socket rate limiting is required.

## Answer

Resolved 2026-09-06 by grilling.

1. **Text**: pure server relay to every attached socket, visitors and participants alike. No buffer anywhere, in memory or in storage. A client that reconnects shows "reconnected, you may have missed messages". Plain text, 2,000 character cap, URLs auto-linked client side, no uploads.
2. **Authority**: the server is authoritative for presence and call membership, derived entirely from attached sockets. Each socket's attachment holds: identity public key, display name, role (visitor or participant), join sequence if participant, sharing flag, muted flag. A call exists exactly when at least one attached socket has role participant.
3. **Propagation**: a full presence snapshot is broadcast to all sockets on every change. No deltas.
4. **Stale sockets**: client pings every 30 s, answered by the hibernation auto-response without waking the object. While a call exists, a room alarm runs every 60 s and drops sockets whose last ping is older than 90 s, then broadcasts a snapshot. With no call, the object hibernates fully and relies on platform close events.
5. **Membership versus media**: server presence wins. A failed peer connection keeps both parties in the call; the client attempts an ICE restart and shows the tile as reconnecting. Only an explicit leave or a dead socket removes a participant.
6. **Server reconnect**: the client keeps peer connections alive, reconnects with exponential backoff capped at 30 s, and re-declares identity, role, sharing, and muted. **Polite role is decided by comparing identity public keys** (amends the stack decision), so reconnection needs no state to survive. Join sequence is used only for who sends the first offer.
7. **Client state while disconnected from the server**: "reconnecting" banner; presence frozen and dimmed; text input disabled; voice and shares continue. After 30 s the banner reads "server unavailable, retrying".
8. **Message set over the socket**: signaling (point-to-point, participants only), presence snapshot (server to all), text, call join and leave, share started and stopped, subscribe and unsubscribe, mute changed, ping. Not over the socket: speaking indicators (computed locally from received audio) and typing indicators (do not exist).
9. **Rate limit**: 20 messages per second per socket, burst 40, excess dropped with an error frame.
10. **Transparency requirement** (raised here, owned by the UI and behaviour tickets): the UI always shows per-peer connection state, including whether a link is direct or relayed through TURN, and marks a peer that is unreachable.
