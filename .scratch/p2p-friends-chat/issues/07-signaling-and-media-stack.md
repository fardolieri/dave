# Signaling and media stack decision

Type: grilling
Status: resolved
Blocked by: 01, 02, 06

## Question

Given the research, which connection stack does the spec commit to? Decide: the media layer (raw WebRTC or a library), the signaling channel (plain WebSocket or a framework's own), how the mesh is formed when a participant joins and torn down when they leave, how a new share is announced and subscribed to, and how TURN credentials reach the client. Record the alternatives rejected and why. If the decision is hard to reverse and surprising, write an ADR.

## Answer

Resolved 2026-09-06 by grilling. Recorded as ADR [0001](../../../docs/adr/0001-raw-webrtc-mesh-with-pre-negotiated-transceivers.md).

1. **Media layer: raw WebRTC**, one `RTCPeerConnection` per remote participant, W3C perfect-negotiation pattern. Trystero rejected (Node-only relay, no auth hook, no Presence, static ICE config); PeerJS, simple-peer, libp2p, Iroh rejected per research.
2. **Signaling channel: our own WebSocket server**, the same socket that carries Presence and ephemeral text. Gated by the shared secret (mechanism decided in the access and identity ticket).
3. **Mesh formation**: the server assigns each participant a join sequence number. The newcomer creates the peer connection and first offer to each existing participant. On glare, the participant whose identity public key compares lower is polite and rolls back (amended 2026-09-06 in the presence and text transport decision; was join sequence, which does not survive a server reconnect). On leave, the server announces it and each remaining participant closes that connection.
4. **Transceiver model**: every peer connection opens with fixed transceivers, one voice audio, one share video, one share audio. Start share is `replaceTrack(track)`, stop is `replaceTrack(null)`. Offer/answer happens only at join and leave. **One share per participant at a time.** UI renders share tiles from signaling state, not `track` events.
5. **Share announcement and subscription**: sharer announces "sharing started/stopped" over the WebSocket. A new share flows to nobody. A viewer sends "subscribe to X" / "unsubscribe from X"; the sharer honours it with `encodings[0].active` on that one connection. Per-viewer caps (`maxBitrate`, `scaleResolutionDownBy`, `maxFramerate`) are set on the same call; values belong to the voice and share behaviour ticket.
6. **Control messages**: all in-call control (subscribe, mute state, speaking indicators, share announcements) travels over the server WebSocket. No data channels.
7. **TURN credentials**: minted server-side, returned in the reply to "join call" with the provider's max TTL, refreshed on rejoin. Before an ICE restart with expired credentials, the client requests fresh ones and applies them with `setConfiguration`.
8. **Runtime neutrality**: the signaling core is written against Web-standard WebSocket and Request/Response APIs with a thin adapter per runtime (Cloudflare Durable Object, Bun, Node).
9. **Mesh spike**: a prototype ticket validates join, leave, share start and stop across a 5-tab Firefox and Chromium mesh before the spec is assembled.

Consequences for other tickets: hosting is free to pick on cost and ops alone; presence and text transport assumes the single server WebSocket and the join-sequence numbers; voice and share behaviour owns per-viewer encoding caps and any cap on shares viewed at once.
