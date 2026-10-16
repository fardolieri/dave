---
status: accepted
date: 2026-10-15
---

# Files are announced through the Room and pulled from friends peer to peer

Friends want to send photos, GIFs and videos into the chat and see them inline, and later files of any size. The Room is a
Durable Object that relays small frames; it stores nothing a friend writes, and the owner does not want a cloud store yet.

A file is therefore two things. Its **announcement** travels like a text: sealed with the text key and signed by its writer
(ADR 0005), as `{ t: 'file', sealed, id }`, through the Room, which passes it on without reading it. Inside are the name,
the type, the size, the SHA-256 of the bytes and, for pictures and videos, a preview of a few KB that shows at once. Its
**bytes** never touch the Room: a friend who wants them pulls them from a friend who has them, over a data-only
`RTCPeerConnection` opened for the pull and closed after it (a **file link**). The hash is signed with the announcement, so
bytes from anyone are checked against it before they show.

## Details

- File links are signaled through the Room as `link` frames between any two friends attached to it, visitors included;
  the call's `signal` stays between participants. The offerer is the friend who pulls. Each description's DTLS
  fingerprints are signed by the identity key as in ADR 0004, so the Room cannot sit in the middle of a link either.
- A link asks the Room for ICE servers with `linkice`. The TURN credentials it mints live one hour and are not revoked:
  a pull is short, and one that outlives them only loses its relay.
- The original goes as it is, metadata included (owner, 2026-10-15): a photo's location and camera reach every friend
  who pulls it. Only the preview is made by the sender, downscaled to 160 px and re-encoded.
- Pictures and videos up to 16 MB are pulled by themselves when they arrive, and a pull can be cancelled while it runs,
  for a slow line or a phone on mobile data (owner, 2026-10-16); anything else waits for a click. A file up to 100 MB can be sent for now: it is read, hashed and stored whole. Larger files stream to disk in a
  later ticket.
- Files live in this browser's IndexedDB, by hash, within a budget of 300 MB; the oldest go first, and come back from
  any friend who still has them. Sent files are kept too, so a sender who reloads can still serve them.
- Only pictures and videos of a short list of types show inline, from a blob of that type. Anything else, SVG and HTML
  included, is offered as a download and never rendered: a blob URL has the app's origin.

## Considered options

- The bytes inside the sealed frame, through the Room: no new transport, but a large frame holds up everything behind
  it on the sender's socket, call signaling and the heartbeat included (a 10 MB photo on a 1 Mbit/s uplink takes 80 s),
  and every friend's history grows by the file.
- A cloud store (R2), encrypted before upload: friends offline at the time get the file later, but it is a billed
  product with a quota and retention to look after. The owner does not want one yet; an announcement could name a
  stored copy later without changing anything here.
- The call's own peer connections: only participants have them, and adding a data channel renegotiates the call.

## Consequences

- A file reaches a friend only while someone who has it is online. The chat says whose it is and that it waits.
- The sender uploads once per friend who pulls. Pulling from any friend who has the file spreads that later.
- The Room learns that a file was announced, by whom, when, and its sealed size; it does not learn the name, the type,
  the size of the bytes or the bytes. It sees who opens links to whom, as it sees who calls whom.
- A pull over a relayed link counts against the TURN quota, like a relayed call.
- Amends the P2P spec §2.2 ("no data channels"): file links carry one, and only file links do. The call is unchanged.
