---
status: accepted
date: 2026-09-16
---

# Many rooms, each derived from its invite secret

The app had one room, gated by one secret set at deploy time. Friends need several rooms, created from the app without a redeploy, and a browser should be in all of them at once. A room is now identified by nothing but its shared secret: the room id on the wire (the socket path, and the Durable Object's name) is SHA-256 of the secret under one label, and the auth key the challenge HMAC is keyed with is SHA-256 under another. The server stores only the auth key, handed over by the first correct answer in a room nobody has entered; it never sees the secret. Room names travel in the invite link, not on the server.

## Considered options

- Rooms provisioned at deploy time, one secret each: no create button, and every new room is a redeploy.
- Random room id in the link next to the secret: one more thing to carry and to get wrong; the derived id is free.
- Server-side room creation with a stored name: a name is the one thing worth sharing, but it means server state that can go stale, a rename protocol, and a reason for the server to know more. The link already has to be sent; the name rides along.
- Sending the secret itself on creation: the secret would then be on the server and in its logs; the derived key proves the same thing and is useless outside this room.

## Consequences

- Anyone with the link can (re)create the room: a wiped server loses nothing but presence. There is no room to "delete", only links to stop sharing.
- Starting a room is offered only inside the app, to someone already in a room, so a visitor without a link sees a notice and nothing else. The server itself does not check who creates a room: a scripted client could make one of its own, isolated from everyone else's, bounded by the per-IP upgrade limit. A server-side creation gate is deliberately left out until that costs something.
- Someone who learns a room id (TLS protects it in transit; Cloudflare logs paths) but not the secret cannot enter, and cannot take over a room that exists. They could squat a room id before its creator connects; the creator connects the moment the room is made, so the window is the creator's own first connect.
- The secret rotates by making a new room and sending a new link; the old one just stops being used. `ROOM_SECRET` is gone from the deployment.
- Two friends who received different names for the same secret see different names; the link name is updated when a newer link arrives.
- Each browser opens one socket per room. Presence, text, and calls are per room; a browser is in at most one call.
- Links from before this change (`#<secret>` without a name) still work and land in a room called "Friends"; a browser's old single secret becomes its first room, with its history.
