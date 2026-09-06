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

**Viewer**:
A participant who has chosen to watch a particular share. A share has zero or more viewers; a participant may view several shares.
_Avoid_: Subscriber, watcher, spectator

**Signaling**:
The exchange, through the server, of the offers, answers, and candidates two participants need to connect directly. Never carries media.
_Avoid_: Handshake, negotiation (reserve for the WebRTC offer/answer state machine)

**Relayed**:
A link between two participants whose media passes through a TURN relay because a direct path could not be established. The relay cannot read the media.
_Avoid_: Proxied, tunnelled

**Shared secret**:
The single invite passphrase or link that gates entry to the room. Everyone who holds it is a friend.
_Avoid_: Password, token, invite code

**Fingerprint**:
A short, human-comparable code derived from an identity's public key, shown beside the display name so friends can tell two identities with the same name apart.
_Avoid_: Hash, ID, key ID

**Invite link**:
The URL a friend receives to enter the room. Carries the shared secret in its fragment, which never reaches the server.
_Avoid_: Join link, room URL

**Identity**:
A per-browser keypair that makes a friend's display name stable and unforgeable across sessions.
_Avoid_: Account, login, profile
