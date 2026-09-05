# Presence and ephemeral text transport model

Type: grilling
Status: open
Blocked by: 07

## Question

How do presence and text actually move? Visitors have no peer connections, so text between a visitor and a participant cannot ride a data channel unless visitors also join a data-only mesh. Decide: whether the server relays text or visitors form data channels; who is authoritative for "a call exists" and "who is in it"; how presence updates propagate and how stale entries are expired; what state the server holds and for how long (ideally nothing durable); and what a client shows during reconnection to the server while its peer connections are still alive.
