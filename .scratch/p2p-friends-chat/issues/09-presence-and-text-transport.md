# Presence and ephemeral text transport model

Type: grilling
Status: claimed
Blocked by: 07

## Question

How do presence and text actually move? Visitors have no peer connections, so text between a visitor and a participant cannot ride a data channel unless visitors also join a data-only mesh. Decide: whether the server relays text or visitors form data channels; who is authoritative for "a call exists" and "who is in it"; how presence updates propagate and how stale entries are expired; what state the server holds and for how long (ideally nothing durable); and what a client shows during reconnection to the server while its peer connections are still alive.

Settled upstream in [Signaling and media stack decision](07-signaling-and-media-stack.md): there is a single server WebSocket per client carrying signaling, presence, text, and in-call control; the server assigns join sequence numbers; no data channels.

Settled upstream in [Hosting platform, server runtime, and TURN provider decision](08-hosting-and-runtime.md): the hub is one Durable Object per Room using WebSocket Hibernation, so the server may hold no state that cannot be rebuilt from attached sockets and their 16 KB attachments; per-socket rate limiting is required.
