# WebRTC library landscape for a small mesh

Type: research
Status: open
Blocked by: none

## Question

For a TypeScript SPA doing a full mesh of up to five (tolerate eight) peers with audio plus multiple screen shares, compare: raw WebRTC over a plain WebSocket signaling server, PeerJS, simple-peer, Trystero, and js-libp2p's WebRTC transport. For each: maintenance status and last release, whether it handles mesh and renegotiation (adding and removing share tracks mid-call), whether it can run on a non-Node server runtime, TURN configuration support, bundle size, and known gotchas. Answer from each project's own repo and docs, not blog posts. Findings to `docs/research/webrtc-libraries.md`.
