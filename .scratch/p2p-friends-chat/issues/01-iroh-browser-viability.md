# Iroh viability in the browser for voice and screenshare

Type: research
Status: resolved
Blocked by: none

## Question

Can Iroh serve as the connection layer for a browser SPA that needs real-time voice and screenshare between up to five peers, today? Specifically: does Iroh run in the browser (WASM or otherwise) and with what maturity; does it carry real-time media or only data streams; how does it establish direct connections and relay when it cannot; what does the relay/discovery infrastructure cost and can it be self-hosted free; and how would browser audio and screen capture get onto an Iroh connection at all, given browsers only expose media through WebRTC. Answer against Iroh's own docs, repo, and release notes. Findings to `docs/research/iroh-browser-viability.md`.

## Answer

**Not viable.** Iroh is ruled out as the connection layer.

- Iroh runs in the browser (WASM, since 0.33, Feb 2025) but browser endpoints are **relay-only**: every byte passes through a relay server, never peer-to-peer, because browsers cannot send UDP and Iroh does not use WebRTC. That breaks the media-privacy constraint in spirit and the "decentralized" intent entirely.
- Iroh carries QUIC streams and datagrams, not media. No codecs, jitter buffers, or pacing. In the browser, QUIC is tunnelled inside a WebSocket over TCP, so datagrams become reliable and head-of-line blocked, which is wrong for voice.
- Getting mic and screen `MediaStreamTrack`s onto a non-WebRTC connection needs WebCodecs plus `MediaStreamTrackProcessor`, which Firefox does not support at all. That fails the desktop Firefox target.
- Relay and DNS discovery are free at n0's Community tier (rate-limited, no uptime guarantee) or self-hostable, but a self-hosted relay is an always-on server.
- Iroh's own FAQ says browser hole-punching still needs WebRTC. A community `iroh-webrtc-transport` exists (10 stars, 4 commits, no license); nothing official.

Consequence for the map: the signaling and media stack decision chooses among WebRTC options only.

Findings (with sources): `docs/research/iroh-browser-viability.md` on branch `research/iroh-browser-viability` (commit 9c50b94). Read with `git show research/iroh-browser-viability:docs/research/iroh-browser-viability.md`.
