# Friends Chat

Shared spaces where small groups of friends text, talk, and share screens, with media flowing peer-to-peer and a small server only brokering connections.

## Language

**Room**:
One shared space, entered through its invite link. Has one text chat and at most one call. A browser can be in several rooms at once; one of them is on screen and at most one call is joined.
_Avoid_: Server (Discord sense), channel, lobby

**Room id**:
The room's name on the wire, derived from the shared secret by hashing. Knowing it gets nobody in.
_Avoid_: Room key, room token

**Auth key**:
What the server keeps of a room: a second hash of the shared secret, handed over by the first friend to enter. The challenge is keyed with it. Never the secret itself.
_Avoid_: Verifier (in UI copy; fine in code), password hash

**Call**:
The live voice and screen session in the room. Exists while at least one participant is in it.
_Avoid_: Voice channel, session, meeting

**Rejoin**:
Re-entering the Call without a click because this browser was in it moments ago and the page has since reloaded, whatever caused the reload. Shares you were watching come back with it; your own share does not.
_Avoid_: Reconnect (reserved for the server socket), resume, restore, auto-join

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
The random string in a room's invite link that gates entry to that room. Everyone who holds it is a friend. The room id and the auth key are derived from it.
_Avoid_: Password, token, invite code

**Fingerprint**:
A short, human-comparable code derived from an identity's public key. Never shown beside the name, even when two identities show the same one (friends switch between phone and PC, each its own identity); it lives in the hover title and the profile card.
_Avoid_: Hash, ID, key ID

**Nickname**:
The name this browser shows for a friend's identity instead of their self-declared name. Local: nobody else sees it, and it follows the key, so a friend on a new device starts without one.
_Avoid_: Alias, rename, pet name, contact name

**Invite link**:
The URL a friend receives to enter a room. Carries the shared secret and the room's name in its fragment, which never reaches the server. Opening or pasting one adds the room to the browser's list. The invite panel shows it as text and as a QR code for a phone to scan.
_Avoid_: Join link, room URL

**Unread**:
Texts from others that arrived in a room while another room was on screen. Shown as a count beside the room's name.
_Avoid_: Notifications, badge count (in UI copy)

**Identity**:
A per-browser keypair that makes a friend's display name stable and unforgeable across sessions.
_Avoid_: Account, login, profile

**Profile card**:
The popover that opens from an avatar: name, fingerprint, since when this browser knows the key, and the edits that fit, a nickname for a friend, or your own name and profile picture for everyone.
_Avoid_: Popup, tooltip, user details, modal

**Profile picture**:
The one emoji a friend chose to fill their avatar instead of their initial. Self-declared like the name, travels with it, seen by everyone; none means the initial. It is also the friend's sound: the cue others hear when they join or leave a call is derived from it.
_Avoid_: Avatar (the circle itself, which shows either), icon, emoji (the picker's currency, not the role), image, photo

**Avatar**:
The circle beside a name in the lists: the profile picture when there is one, else the initial. Clicking it opens the profile card.
_Avoid_: Badge, bubble, icon

**Acknowledged**:
An identity this browser has seen and clicked once. Until then it wears a "new" badge. Acknowledging or nicknaming a friend records the key in the browser's address book.
_Avoid_: Trusted, verified, known (in UI copy; fine in code)

**Noise removal**:
RNNoise running on your outgoing voice in your own browser: it takes keyboard clicks, fans and other noise out before anything is sent, and feeds the voice gate. On by default; the browser's own noise suppression steps aside while it runs. It runs on the microphone's own frames where the browser allows it, and stops by itself if the voice it sends runs off real time or the device cannot keep up.
_Avoid_: Noise suppression (the browser's built-in filter, a different thing), noise cancellation, denoiser (in UI copy)

**Voice gate**:
What lets your voice out only while you speak: it opens when RNNoise's voice probability passes the threshold on the Audio panel's slider and holds open briefly after. Below it friends receive silence, and your speaking ring follows it.
_Avoid_: Noise gate (that one goes by loudness), voice activity detection (the measurement, not the gate), input sensitivity

**Low bandwidth voice**:
The setting for a slow or overloaded internet line: voices go at about a third of the data, sounding a little duller, so they stop arriving seconds late, and play from a slightly longer buffer, so an uneven line does not stutter. Asked for by one side, it holds both ways between the two; at the slow end it covers all of that friend's connections.
_Avoid_: Low quality mode, data saver, low bitrate (in UI copy; fine in code)

**Round trip**:
How long a packet takes to a friend and back, shown beside their name. You hear them about half of it late. A line that queues packets makes it seconds.
_Avoid_: Ping, lag, latency (in UI copy; fine in code)

**Voice buffer**:
How long a friend's voice waits in this browser before it plays, so packets that arrive unevenly still play evenly. The browser sets it; low bandwidth voice holds it at 200 ms at least; and it rises by itself, to 200 then 400 ms, when a friend's voice measures rough (made-up stretches or jitter past the marks, judged every 5 s), and falls a step after a clean minute. Per friend, local only.
_Avoid_: Jitter buffer (in UI copy; fine in code), delay, latency

**Voice repair**:
How lost bits of a friend's voice are made up for between two friends, an Audio panel choice. Opus FEC, the usual: a rough copy of each packet rides in the next one. RED: a full copy of the previous packet in every packet, about double the voice data. Off: neither. Chosen by either side it holds both ways; off on either side switches both off.
_Avoid_: Redundancy (alone), error correction, packet loss concealment (that is what the browser makes up by itself)
