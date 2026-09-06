---
status: accepted
date: 2026-09-06
---

# Raw WebRTC mesh over our own WebSocket signaling, with pre-negotiated transceivers

We need voice and multiple screen shares between up to five (tolerate eight) friends with media never touching a server, on free hosting. We build the mesh on raw `RTCPeerConnection` objects signaled over the same WebSocket server that carries Presence and ephemeral text, rather than a WebRTC library, and we open every peer connection with a fixed set of transceivers (voice audio, share video, share audio) so that starting or stopping a share is `replaceTrack` and offer/answer only happens when someone joins or leaves.

## Considered options

- **Trystero over its ws-relay**: mesh and renegotiation for 22 kB, but the relay is Node-only (rules out Cloudflare's free tier), has no auth hook, carries no Presence or Identity so we would run a second channel anyway, and freezes ICE config at join so expired TURN credentials force a rejoin.
- **PeerJS**: cannot add tracks to an existing call, so every share would be a new connection per peer; 2.0 stalled since 2022.
- **simple-peer**: renegotiates, but no commit since February 2022 and needs Node polyfills in a Vite build.
- **js-libp2p WebRTC transport**: data channels only, no media.
- **Iroh**: relay-only in browsers, data not media, and the WebCodecs route fails on Firefox.
- **Renegotiating per share** (adding and removing tracks dynamically): the "natural" WebRTC shape, rejected because it reintroduces glare mid-call, where Firefox has historically been fragile, and it is unnecessary once each participant is limited to one share.

## Consequences

- One share per participant at a time. Share tiles in the UI are rendered from signaling state, not from `track` events, because remote tracks exist (muted, empty) from join time.
- A share flows to nobody until a viewer subscribes; subscribe and unsubscribe are control messages over the server WebSocket that the sharer honours by flipping `encodings[0].active` on that one peer connection.
- Newcomers initiate offers to each existing participant; on glare the participant whose identity public key compares lower is polite. (Amended 2026-09-06: was join sequence, which does not survive a server reconnect.)
- All in-call control messages (subscribe, mute state, speaking, share announcements) travel over the server WebSocket. Data channels are not used.
- TURN credentials are minted server-side and returned in the reply to "join call" with the provider's maximum TTL; refreshed on rejoin or, before an ICE restart, via `setConfiguration`.
- The signaling core is written against Web-standard WebSocket and Request/Response APIs with a thin adapter per runtime, so hosting can choose between Cloudflare Durable Objects and a Node or Bun process freely.
- Only the offering side pre-adds the three transceivers. The answering side adopts the ones the offer creates, flips them to send-receive, and attaches its tracks before answering. JSEP associates offered lines only with transceivers created by `addTrack`, so pre-adding on both sides yields six transceivers and two rounds (found in the mesh spike, 2026-09-06).
- Deactivating a share encoding for a peer that just joined must wait until the answer is applied; before that the sender has no encodings and `setParameters` throws.
- We own the perfect-negotiation loop, ICE restart, and reconnection logic. The mesh spike (branch `prototype/mesh-spike`) validated all of the above on Firefox and Chromium, including 114 forced offer collisions with zero errors.
