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
A short, human-comparable code derived from an identity's public key. Shown beside the name only while this browser has not acknowledged the key or while two identities show the same name; otherwise it lives in the hover title.
_Avoid_: Hash, ID, key ID

**Nickname**:
The name this browser shows for a friend's identity instead of their self-declared name. Local: nobody else sees it, and it follows the key, so a friend on a new device starts without one.
_Avoid_: Alias, rename, pet name, contact name

**Invite link**:
The URL a friend receives to enter the room. Carries the shared secret in its fragment, which never reaches the server.
_Avoid_: Join link, room URL

**Identity**:
A per-browser keypair that makes a friend's display name stable and unforgeable across sessions.
_Avoid_: Account, login, profile

**Profile card**:
The popover that opens from an avatar: name, fingerprint, since when this browser knows the key, and the edits that fit, a nickname for a friend, or your own name and profile picture for everyone.
_Avoid_: Popup, tooltip, user details, modal

**Profile picture**:
The one emoji a friend chose to fill their avatar instead of their initial. Self-declared like the name, travels with it, seen by everyone; none means the initial.
_Avoid_: Avatar (the circle itself, which shows either), icon, emoji (the picker's currency, not the role), image, photo

**Avatar**:
The circle beside a name in the lists: the profile picture when there is one, else the initial. Clicking it opens the profile card.
_Avoid_: Badge, bubble, icon

**Acknowledged**:
An identity this browser has seen and clicked once. Until then it wears a "new" badge and its fingerprint. Acknowledging or nicknaming a friend records the key in the browser's address book.
_Avoid_: Trusted, verified, known (in UI copy; fine in code)
