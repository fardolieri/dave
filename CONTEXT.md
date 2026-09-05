# Friends Chat

A single shared space where a small group of friends can text, talk, and share screens, with media flowing peer-to-peer and a small server only brokering connections.

## Language

**Room**:
The single shared space. Has one text chat and at most one call.
_Avoid_: Server (Discord sense), channel, lobby

**Call**:
The live voice and screen session in the room. Exists while at least one participant is in it.
_Avoid_: Voice channel, session, meeting

**Participant**:
A friend currently in the call.
_Avoid_: Member, peer (reserve "peer" for the transport layer), user

**Visitor**:
A friend who has the page open but is not in the call. Visitors see presence and can read and write text.
_Avoid_: Lurker, spectator, viewer (reserve "viewer" for someone watching a share)

**Presence**:
The list of participants and visitors, published by the server and visible without joining the call.
_Avoid_: Roster, online list

**Share**:
One screen or window stream published by a participant. Several participants may share at once; each other participant chooses which shares to view.
_Avoid_: Screencast, stream (transport term)

**Shared secret**:
The single invite passphrase or link that gates entry to the room. Everyone who holds it is a friend.
_Avoid_: Password, token, invite code

**Identity**:
A per-browser keypair that makes a friend's display name stable and unforgeable across sessions.
_Avoid_: Account, login, profile
