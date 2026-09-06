# Map: P2P friends chat

Label: wayfinder:map

## Destination

A spec, ready to hand to an implementer, for a single-room web app where up to five friends share text, voice, and screen over peer-to-peer media, brokered by a small server on a free hosting tier, gated by a shared secret, with the running call visible before you join.

## Notes

- Domain: real-time web, WebRTC, small self-hosted group tooling. Glossary lives in `CONTEXT.md` at the repo root; use its terms (Room, Call, Participant, Visitor, Presence, Share, Shared secret, Identity).
- Tracker: local markdown, see `docs/agents/issue-tracker.md`. Tickets live in `issues/` next to this file. Research findings go in `docs/research/<slug>.md`.
- Skills every session should consult: `grilling` and `domain-modeling` for grilling tickets; `research` for research tickets; `prototype` for prototype tickets.
- Standing constraints from charting (2026-09-05):
  - Hosting and relay must cost nothing. "Free tier with limits" is fine; "cheap" is not.
  - Media (voice, shares) must never be decrypted by a server. A TURN relay that forwards encrypted bytes is acceptable.
  - Design for 5 participants in a call, tolerate 8. No SFU.
  - Text chat is ephemeral: live relay only, nothing stored.
  - Stack: TypeScript end to end, Solid 2 (release candidate) for the SPA, Node plus wrangler toolchain, workerd in production (decided 2026-09-06, was "Node or Bun").
  - Targets: desktop Chromium and Firefox fully. Mobile browsers for voice, text, and viewing shares as a stretch.
- Plan, don't do: this map produces decisions and a spec, not code. The one exception is the prototype ticket, which produces throwaway UI.

## Decisions so far

<!-- one line per resolved ticket: gist, then link to the ticket for detail -->

- [Iroh viability in the browser for voice and screenshare](issues/01-iroh-browser-viability.md): not viable. Browser Iroh is relay-only, carries data not media, and the WebCodecs route fails on Firefox. WebRTC only from here.
- [WebRTC library landscape for a small mesh](issues/02-webrtc-libraries.md): two candidates survive, raw WebRTC over our own WebSocket signaling or Trystero. PeerJS cannot add share tracks mid-call, simple-peer is unmaintained, libp2p is data-only. TURN credentials must reach the client before peers are built.
- [Free hosting for an always-on WebSocket hub and static SPA](issues/03-free-hosting-websocket-hub.md): only Cloudflare Workers + Durable Objects, Oracle Always Free VM, and GCP e2-micro stay up for free. Cloudflare is card-free but not Node; the VMs run Node or Bun but need a card on file. Deno Deploy and Render sleep when idle.
- [Free TURN relay options](issues/04-free-turn-providers.md): Cloudflare Realtime TURN (1,000 GB/month) is the only hosted free tier with real headroom, card status unconfirmed. Metered is 20 GB or 500 MB depending on which of its pages you believe. Self-hosted coturn on an Oracle free VM is the unlimited fallback. All need server-minted short-lived credentials.
- [Multiple simultaneous screen shares in a WebRTC mesh](issues/06-multistream-screenshare.md): works if viewers opt in per share and sharers pause encoding for non-watchers via setParameters or replaceTrack, no renegotiation needed. Sharer upload is 2.5 Mbps per watching peer. Publishing is desktop-only; share audio is Chromium-only; mobile can view with a wake lock.
- [Solid 2 release-candidate status and fit](issues/05-solid-2-status.md): rc.6 as of 2026-09-02, API frozen, weekly fixes, one open P1 store bug. Usable if all packages are pinned in lockstep; skip the router entirely. MediaStream objects are never proxied by stores, so WebRTC state must be mirrored into signals.
- [Signaling and media stack decision](issues/07-signaling-and-media-stack.md): raw WebRTC mesh over our own WebSocket server, fixed transceivers per connection so only join and leave renegotiate, one share per participant, shares flow to nobody until a viewer subscribes, all control over the WebSocket, TURN credentials minted at join, runtime-neutral signaling core. ADR 0001.
- [Hosting platform, server runtime, and TURN provider decision](issues/08-hosting-and-runtime.md): Cloudflare Workers + Durable Objects for hub and SPA, Cloudflare Realtime TURN for relay, all on one free account with a card allowed but zero spend. Node plus wrangler toolchain, Bun dropped. Hibernation means server state is derived from attached sockets only. GitHub Actions deploys. ADR 0002.

## Not yet specified

- Reconnection and failure behaviour: what a participant sees when the server restarts, when a peer drops, when their own network flaps. ICE restart with refreshed TURN credentials is settled; the rest sharpens once the presence and transport model is decided.
- Exact mobile scope: publishing a share does not exist on mobile (settled by research); what remains is how the UI hides it and whether voice and viewing shares are actually reliable on iOS Safari and Android Chrome. Depends on the UI prototype and the voice and share behaviour ticket.
- Background notification when a friend starts or joins a call while the tab is unfocused, and whether that is in the spec at all.
- Voice controls: mute, push-to-talk, device selection, noise suppression. Sharpens in the voice and share behaviour ticket, may spill into its own.
- Shape and level of detail of the final spec document, and where it lives in the repo.

## Out of scope

- Multiple rooms or channels. One room exercises the whole hard part; channels are a data-model layer for a later effort.
- Camera video. Not requested; voice and shares only.
- Persistent text history, encrypted or not. Ruled out on 2026-09-05 in favour of ephemeral text.
- Accounts, allowlists, or third-party sign-in. The shared secret is the boundary.
- Visitor visibility with an invisible mode (seeing who is online but not in the call). Deferred to a later effort; noted so a privacy toggle is designed in when it comes.
- Selective forwarding unit or any server that handles media. Contradicts the privacy constraint and the participant ceiling makes it unnecessary.
