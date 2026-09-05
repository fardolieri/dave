# Iroh viability in the browser for voice and screenshare

Type: research
Status: open
Blocked by: none

## Question

Can Iroh serve as the connection layer for a browser SPA that needs real-time voice and screenshare between up to five peers, today? Specifically: does Iroh run in the browser (WASM or otherwise) and with what maturity; does it carry real-time media or only data streams; how does it establish direct connections and relay when it cannot; what does the relay/discovery infrastructure cost and can it be self-hosted free; and how would browser audio and screen capture get onto an Iroh connection at all, given browsers only expose media through WebRTC. Answer against Iroh's own docs, repo, and release notes. Findings to `docs/research/iroh-browser-viability.md`.
