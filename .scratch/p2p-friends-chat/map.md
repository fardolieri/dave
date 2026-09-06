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
- Transparency: the UI always shows the real connection state. Per-peer direct versus relayed through TURN, reconnecting, unreachable, and the server socket state are visible, never hidden behind a generic spinner. Raised 2026-09-06.
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
- [Provision the Cloudflare account, TURN key, and deploy secrets](issues/15-provision-cloudflare.md): done. Free plan, TURN key created with no plan change, three GitHub secrets in place, $1 budget alert, app URL dave.danielmittereder.workers.dev created by first deploy.
- [Presence and ephemeral text transport model](issues/09-presence-and-text-transport.md): server relays text with no buffer; presence and call membership derived from attached sockets and broadcast as full snapshots; ping auto-response plus a 60 s alarm during calls sweeps dead sockets; server presence wins over media failure; polite role now by identity key so reconnects need no state; speaking indicators stay local; 20 msg/s rate limit.
- [Access gating and stable identity](issues/10-access-and-identity.md): HMAC challenge-response over a nonce bound to the client public key, secret never on the wire, delivered via invite-link fragment. Non-extractable ECDSA P-256 in IndexedDB. Server tags attribution, clients trust it. Name plus six-char fingerprint, "new" badge for unseen keys, duplicates allowed, no key recovery. ADR 0003.
- [Room UI prototype: visitor and participant views](issues/11-room-ui-prototype.md): two columns, presence sidebar with Online above Call and stacked full-width actions, chat fills the main column until someone shares, then shares split in above the chat side by side. Chat always visible. Phone width is one scrolling column. Prototype on branch prototype/room-ui, variant D.
- [Voice and share behaviour](issues/12-voice-and-share-behaviour.md): voice activity plus mute, processing toggles behind a warning, device pickers via customizable select with fallback. Share settings are tunable: Motion and Detail presets, 15/30/60 fps, resolution, degradation preference, configurable upload budget (default 8 Mbps, 2.5 per viewer). Fullscreen unsubscribes other shares. Connection badges from stats every 2 s. Mobile best effort. Title badge and chimes.
- [Mesh negotiation spike across Firefox and Chromium](issues/14-mesh-negotiation-spike.md): the pre-negotiated model survives both browsers. 114 forced offer collisions resolved with zero errors; share start, stop, restart, subscribe toggles, live constraint changes, and jitter-buffer target all work. Two mechanics corrected: only the initiator pre-adds transceivers, and share deactivation waits for the answer. Prototype on branch prototype/mesh-spike.

## Not yet specified

- Shape and level of detail of the final spec document, and where it lives in the repo.

## Out of scope

- Multiple rooms or channels. One room exercises the whole hard part; channels are a data-model layer for a later effort.
- Camera video. Not requested; voice and shares only.
- Persistent text history, encrypted or not. Ruled out on 2026-09-05 in favour of ephemeral text.
- Accounts, allowlists, or third-party sign-in. The shared secret is the boundary.
- Visitor visibility with an invisible mode (seeing who is online but not in the call). Deferred to a later effort; noted so a privacy toggle is designed in when it comes.
- Identity recovery or key linking across browsers. Non-extractable keys were chosen deliberately; a linking flow (new browser shows a code, old browser signs it) is a later effort. Ruled out 2026-09-06 in the access and identity decision.
- Push-to-talk. Needs a keybinding UI and a global key listener; voice activity plus mute covers the group. Ruled out 2026-09-06.
- System notifications via the Notification API. Title badge and chimes are in; OS-level notifications are not worth the permission prompt. Ruled out 2026-09-06.
- Low-resolution first-frame preview thumbnails on share tiles for non-watchers. Liked, deliberately deferred to a later effort; tiles say "click to watch" for now. Ruled out 2026-09-06.
- Selective forwarding unit or any server that handles media. Contradicts the privacy constraint and the participant ceiling makes it unnecessary.
