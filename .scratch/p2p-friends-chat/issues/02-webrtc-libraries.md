# WebRTC library landscape for a small mesh

Type: research
Status: resolved
Blocked by: none

## Question

For a TypeScript SPA doing a full mesh of up to five (tolerate eight) peers with audio plus multiple screen shares, compare: raw WebRTC over a plain WebSocket signaling server, PeerJS, simple-peer, Trystero, and js-libp2p's WebRTC transport. For each: maintenance status and last release, whether it handles mesh and renegotiation (adding and removing share tracks mid-call), whether it can run on a non-Node server runtime, TURN configuration support, bundle size, and known gotchas. Answer from each project's own repo and docs, not blog posts. Findings to `docs/research/webrtc-libraries.md`.

## Answer

**Two live candidates: raw WebRTC over our own WebSocket signaling, or Trystero.** PeerJS, simple-peer, and js-libp2p are dropped.

- **Raw WebRTC + plain WebSocket**: one `RTCPeerConnection` per peer using the W3C "perfect negotiation" pattern handles adding and removing share tracks mid-call. Signaling runs on Node (`ws`), Bun, or Deno with no library constraint. We need that server anyway for Presence and ephemeral text.
- **Trystero** (0.25.4, 2026-08-30): implements perfect negotiation internally and fans `addStream`/`removeStream`/`addTrack`/`replaceTrack` to every peer in a room. Its self-hosted `ws-relay` targets Node. Its serverless strategies (Nostr, MQTT, BitTorrent, etc.) announce the room on public third-party relays, which conflicts with a private friends room. 22 kB gzipped.
- **PeerJS** (1.5.5, 2025-06-07): alive, but `MediaConnection` has no add/remove-track API and no `onnegotiationneeded` handler, so every new share is a new call per peer. Issue open since 2021.
- **simple-peer** (9.11.1): renegotiates, but no commit in 3.5 years.
- **js-libp2p WebRTC transport**: data channels only, cannot carry media tracks. Out.
- **TURN**: all options take a static `iceServers` list; only libp2p accepts an async provider. So the server must hand short-lived TURN credentials to the client before it constructs peer connections.

Consequence for the map: the stack decision is a two-way choice, raw WebRTC versus Trystero over its ws-relay. Presence and text transport should assume our own WebSocket server exists either way.

Findings (with sources): `docs/research/webrtc-libraries.md` on branch `research/webrtc-libraries` (commit adede1d). Read with `git show research/webrtc-libraries:docs/research/webrtc-libraries.md`.
