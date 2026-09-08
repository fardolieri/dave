# Spec: P2P friends chat

Status: ready for implementation. Assembled 2026-09-06 from the wayfinder map at [map.md](map.md); every section links the ticket that holds the reasoning. Vocabulary is defined in [CONTEXT.md](../../CONTEXT.md) (Room, Call, Participant, Visitor, Presence, Share, Viewer, Signaling, Relayed, Shared secret, Identity, Fingerprint, Invite link) and is used here without redefinition. Architecture decisions that are hard to reverse are recorded as ADRs in [docs/adr/](../../docs/adr/).

## 1. Overview

A single-room web app where up to five friends (tolerate eight) share text, voice, and screen. Media flows peer to peer over a WebRTC mesh and never passes through a server we can read. A small server brokers connections, publishes presence, and relays ephemeral text. Entry is gated by one shared secret. Anyone with the page open sees who is in the call before deciding to join.

Standing constraints (from the map's Notes):
- Hosting and relay cost nothing. Workers and Durable Objects fail on overage; TURN is the one billable product and is accepted (see §9).
- Media is never decrypted by a server. A TURN relay forwarding encrypted bytes is acceptable.
- Text is ephemeral: live relay only, nothing stored anywhere.
- Desktop Chromium and Firefox are the targets. Mobile is best effort (§7.5).
- The UI always shows the real connection state; nothing hides behind a generic spinner.

## 2. Architecture

### 2.1 Stack

TypeScript end to end. SPA in Solid 2 (release candidate), server on Cloudflare Workers with one Durable Object per Room. No router: the app is one page. From [Solid 2 release-candidate status and fit](issues/05-solid-2-status.md):
- Pin exact versions of `solid-js`, `@solidjs/web`, `@solidjs/signals`, `@solidjs/vite-plugin`; commit the lockfile; upgrade deliberately. rc.6 as of 2026-09-02; one open P1 store bug (#3284) affects derived stores, which this design avoids.
- WebRTC objects (`RTCPeerConnection`, `MediaStream`, `MediaStreamTrack`) are platform objects and are never proxied by Solid stores. Hold them in signals or a shallow store keyed by peer, and mirror every state you render (track ended, muted, ICE state) into plain signals from WebRTC events. Never read state off a media object in JSX.
- Plain Vite SPA shape: `index.html` plus a `render()` entry from `@solidjs/web`. The prototype used this shape successfully; the plugin's "start" mode was not needed.
- Toolchain: Node 20.19+ or 22.12+, wrangler, `@cloudflare/vitest-pool-workers` for tests inside workerd. Bun is not used.

### 2.2 Media and signaling (ADR 0001)

From [Signaling and media stack decision](issues/07-signaling-and-media-stack.md), verified by [Mesh negotiation spike across Firefox and Chromium](issues/14-mesh-negotiation-spike.md):
- One `RTCPeerConnection` per remote participant. Full mesh, no SFU, no data channels.
- Signaling rides the same WebSocket that carries presence, text, and in-call control (§5).
- **Fixed transceivers per connection**: voice audio, share video, share audio. The offering side pre-adds them with `addTransceiver(kind, { direction: 'sendrecv' })`. The answering side must **not** pre-add: it lets `setRemoteDescription` create the three, sets each `direction = 'sendrecv'`, attaches its tracks with `replaceTrack`, then answers. (JSEP only associates offered lines with `addTrack`-created transceivers; pre-adding on both sides yields six transceivers and two rounds.)
- Offer/answer happens only when a participant joins or leaves. Starting a share is `replaceTrack(track)`, stopping is `replaceTrack(null)`. One share per participant at a time.
- **Perfect negotiation** (W3C pattern) on every connection. Polite side is the participant whose identity public key compares lower as a string. This survives server reconnects. Verified under 114 forced simultaneous offer collisions with zero errors on Chromium and Firefox.
- **Mesh formation**: the server assigns each participant a join sequence. The newcomer (higher sequence) creates the connection and first offer to each existing participant. On leave the server announces it and each remaining participant closes that connection.
- **Share subscription**: a new share flows to nobody. A viewer sends `subscribe`/`unsubscribe` for a sharer; the sharer sets `encodings[0].active` on its share video and share audio senders for that one connection. Deactivating for a peer that has just joined must wait until the answer is applied (the sender has no encodings before that; retry every 100 ms). The UI renders share tiles from signaling state, not from `track` events, because remote tracks exist muted from join time.
- **TURN credentials** are returned by the server in the reply to `join` (§6.4) and refreshed on rejoin. Before an ICE restart with expired credentials the client requests fresh ones and applies them with `setConfiguration`.
- The signaling core is written against Web-standard WebSocket and Request/Response APIs with a thin adapter per runtime. The Durable Object is the production adapter; tests run inside workerd.

### 2.3 Hosting (ADR 0002)

From [Hosting platform, server runtime, and TURN provider decision](issues/08-hosting-and-runtime.md) and [Provision the Cloudflare account, TURN key, and deploy secrets](issues/15-provision-cloudflare.md):
- Cloudflare Workers Free plan. One Worker named `dave` serving the SPA as static assets (never routed through the Worker script, so requests are free and unlimited) and handling exactly two dynamic paths: the WebSocket upgrade and nothing else; TURN minting happens inside the room object as part of `join`.
- One Durable Object per Room (SQLite-backed, storage unused) using the **WebSocket Hibernation API**. The object holds no state that cannot be rebuilt from attached sockets and their per-socket attachments (16 KB cap each).
- App URL `https://dave.danielmittereder.workers.dev`. The account subdomain is not recorded in the repo; a custom domain later is a config change.
- Deploys: GitHub Actions on push to `master` running `cloudflare/wrangler-action@v3` with repository secrets `CLOUDFLARE_API_TOKEN` (from the "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`. The Worker is created by the first deploy; no dashboard step.
- Secrets: `TURN_KEY_API_TOKEN` and the shared secret live as Worker secrets, pushed from GitHub repository secrets by the deploy workflow's `secrets` input. The TURN key ID `d3d456166c56302f67957272a1ff9ba5` is not secret and lives in `wrangler.toml` as `TURN_KEY_ID`. The repo `fardolieri/dave` is public.
- All friends are in one region; Durable Object placement near the first requester is fine.

### 2.4 TURN

Cloudflare Realtime TURN. STUN `stun:stun.cloudflare.com:3478` is free and may be shipped to visitors. Credentials are minted server-side per participant on `join` via `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers` with `{"ttl": 43200}` (12 hours; provider maximum 48 hours) and `Authorization: Bearer $TURN_KEY_API_TOKEN`; the returned `iceServers` array is forwarded as is. Revoke on leave with `POST .../credentials/$USERNAME/revoke`. Include `turns:turn.cloudflare.com:443?transport=tcp` last so UDP is tried first. Fallback provider if Cloudflare TURN ever requires a paid plan: Metered Open Relay, quota to be confirmed in its dashboard. Sources: [Free TURN relay options](issues/04-free-turn-providers.md).

## 3. Access and identity (ADR 0003)

From [Access gating and stable identity](issues/10-access-and-identity.md).

- **Invite link**: the shared secret travels in the URL fragment, which browsers never send to the server. On first load the client stores it locally and strips it from the address bar immediately (a friend screensharing their browser must not leak it). Rotation is manual: change the Worker secret, send a new link.
- **Identity**: an ECDSA P-256 keypair from WebCrypto, private key `extractable: false`, stored as a `CryptoKeyPair` in IndexedDB. Generated on first visit. Losing site data means a new identity; there is no recovery or export.
- **Connect handshake**: the server sends a 32-byte random nonce. The client replies with `HMAC-SHA256(secret, nonce || publicKey)` and an ECDSA signature over the nonce. The server recomputes the HMAC from its Worker secret, verifies the signature against the public key, and only then attaches the socket with the identity in its attachment. The secret never crosses the wire; a transcript cannot replay; the proof is bound to the identity.
- **Attribution**: the server tags every relayed message and presence entry with the sender's verified public key. Clients trust the tag. No per-message signatures. This trust in our own server is deliberate and recorded in ADR 0003.
- **Names**: self-declared display name plus a six-character fingerprint derived from the public key hash. Duplicates allowed; the UI warns "someone else in the room is also called X" and shows your own fingerprint. Each client keeps a local seen-keys list (key, last name) and shows a "new" badge on a never-seen key until the user has interacted with it once.
- **Abuse**: three wrong challenge answers close the connection. The Worker in front of the room object rate-limits upgrade attempts per IP with the platform rate limiter so failed attempts never wake the object.

## 4. Presence and text

From [Presence and ephemeral text transport model](issues/09-presence-and-text-transport.md).

- **Authority**: the server is authoritative for presence and call membership, derived entirely from attached sockets. Each socket's attachment holds: public key, display name, role (visitor or participant), join sequence if participant, sharing flag, muted flag. A Call exists exactly when at least one attached socket has role participant.
- **Propagation**: a full presence snapshot is broadcast to every socket on every change. No deltas.
- **Stale sockets**: the client pings every 30 s; the hibernation auto-response answers without waking the object. While any socket is attached, a Durable Object alarm runs every 60 s and drops sockets whose last ping is older than 90 s, then broadcasts a snapshot. (Amended 2026-09-06 during ticket 03: originally only while a Call existed, but killed browsers were observed lingering as ghost visitors for minutes, and 1,440 brief wakes a day are negligible against the budget.) With no sockets at all the object hibernates fully.
- **One socket per identity** (2026-09-08): a successful authentication closes every other socket attached under the same public key with code 4004 "opened elsewhere". This removes ghosts at once (a client that reconnected while the server had not yet noticed its old socket die) instead of after the 90 s sweep, and settles two tabs of one browser deterministically: the older tab shows "open in another tab" and stops reconnecting until its "use it here instead" button supersedes the newer one in turn. Lookups by public key (signal and subscribe targets, incoming offers) match the participant entry, never a stale visitor entry of the same key.
- **Text**: pure relay to every attached socket, visitors and participants alike. The server keeps no buffer in memory or storage and adds nothing to the message beyond the sender tag and timestamp. Each browser keeps the most recent 500 texts it received in IndexedDB and can clear them (added 2026-09-07, ticket 09); histories therefore differ between friends. Plain text, 2,000 characters max, URLs auto-linked client side, no uploads. The log is a reversed flex column with the newest line at the bottom next to the composer: staying at the newest line across new lines and size changes is the browser's default, a reader who scrolled up is held in place when lines arrive, and a small dim "new messages ↓" pill offers the way back; sending your own message always returns to the bottom (2026-09-08). A client that reconnects writes a dated, muted line into the chat and its local history saying roughly how long it was offline ("Reconnected after about 47 s offline. Messages sent meanwhile are missing here."), so the gap stays visible later. Every reconnect gets its own line; nothing is collapsed (2026-09-08).
- **Rate limit**: 20 messages per second per socket, burst 40, for everything except signaling; signaling (offers, answers, batched ICE candidates) has its own bucket of 100 per second, burst 400. Excess is dropped with an error frame. (Amended 2026-09-06: the single bucket dropped ICE candidates on real joins against Cloudflare TURN and stalled connections for tens of seconds.) Clients batch candidates per peer within about 60 ms. This is what protects the daily request budget (§9).

## 5. Wire protocol

Everything is JSON over the one WebSocket. Message set (§4 and §2.2):
- Server to all: `presence` (full snapshot; mute and sharing flags travel here rather than as separate relayed messages), `left` (a participant left on purpose; a vanished socket only drops out of the snapshot), `text`.
- Client to server: `text` (relayed to all), `join` with the muted flag (reply `call` carries join sequence and `iceServers`), `leave`, `mute`, `ice` (fresh TURN credentials, reply `ice`), `ping`.
- Point to point between participants, relayed by the server by target public key: `signal` (description or candidate), `subscribe`, `unsubscribe`.
- Errors carry `reason` and, when known, `ref`, the client message type that was rejected.
(Amended 2026-09-06 while building ticket 04.)
- Not over the socket, ever: speaking indicators (computed locally from received audio, §6.1) and typing indicators (do not exist).
Every relayed message is tagged by the server with the sender's public key (§3). Signaling messages are delivered only to participants.

## 6. Voice and shares

From [Voice and share behaviour](issues/12-voice-and-share-behaviour.md) and [Multiple simultaneous screen shares in a WebRTC mesh](issues/06-multistream-screenshare.md).

### 6.1 Voice
- Always on with voice activity, plus Mute. No push-to-talk.
- Join unmuted; last mute state remembered per browser. Mute sets the local track `enabled = false` (no renegotiation) and broadcasts `mute`.
- Echo cancellation, noise suppression, and automatic gain default on. A settings popover exposes the three toggles behind a small warning that changing them usually makes you sound worse to others, plus microphone selection and speaker selection where the browser supports output devices. Pickers use the customizable select (`appearance: base-select`, Chrome 135, Safari 27) with a plain `<select>` fallback (Firefox has it behind flags as of 149). Choices remembered per browser.
- Speaking indicators: a local audio analyser on the own mic and every received voice track lights a ring on the avatar past a threshold with a short hold.
- Local volume per participant (added 2026-09-07, ticket 08): a speaker button on each other participant's row reveals a 0 to 200 percent slider (WebAudio gain) that scales that person's voice and share audio for you only. Nothing is signalled. Remembered per browser keyed by the participant's public key; the row shows the percentage when it is not 100.

### 6.2 Starting and stopping a share
- The Share screen button calls `getDisplayMedia` with video at the configured frame rate, `audio: true`, `systemAudio: 'include'`, `selfBrowserSurface: 'exclude'`, `surfaceSwitching: 'include'`. Share audio is Chromium-only and best effort; Firefox and Safari shares are silent.
- Stopping is the button or the browser's own stop control, both detected by the track ending, then announced with `share`.
- Publishing is desktop-only: `getDisplayMedia` does not exist on iOS Safari, Android Chrome, or Android Firefox. Hide the button where it is undefined.

### 6.3 Share settings (tunable, first class)
A gear next to Share screen opens share settings, applied live without renegotiation and remembered per browser:
- Presets: **Motion** (60 fps, scaled to about 720p, `contentHint = 'motion'`, `degradationPreference = 'maintain-framerate'`) for game streams; **Detail** (15 to 30 fps, native resolution, `contentHint = 'detail'`, `degradationPreference = 'maintain-resolution'`) for browsers and documents. Default: Detail at 30 fps.
- Advanced: frame rate (15, 30, 60), resolution (native, 1080p, 720p), degradation preference (framerate, resolution, balanced), upload budget and per-viewer ceiling (§6.4). Frame rate and resolution apply with `applyConstraints` on the share track (verified live on Chromium and Firefox); encoding limits with `setParameters` per peer.
- Viewer-side "low latency" toggle sets `jitterBufferTarget` on the receivers (Chrome 124, Firefox 115, Safari 27).

### 6.4 Bandwidth rule
The sharer's upload is the bottleneck: one encode per watching peer, 2.5 Mbps per stream by default. Default upload budget 8 Mbps per share, divided equally among active viewers, per-viewer ceiling 2.5 Mbps, floor 1 Mbps, applied as `maxBitrate` on each viewer's connection as subscriptions change. Budget and ceiling are user-configurable. A viewer on a small screen requests half resolution, applied for that peer only with `scaleResolutionDownBy`. Relayed pairs push the same bytes through TURN: about 1.1 GB per hour per 2.5 Mbps stream.

### 6.5 Viewing
- Any number of shares may be watched at once. Clicking a tile that is not watched subscribes. Clicking a running tile puts the tile (not the video element) into fullscreen, so our header and stats bar stay and the browser's playback controls never appear; clicking anywhere in fullscreen leaves it. In fullscreen the header and stats bar fade out 2.5 s after the pointer last moved (cursor hidden too) and return on any movement, staying while the pointer rests on them. A "Stop watching" button in the tile header unsubscribes; a fullscreen button sits at the bottom right of the stats bar. Entering fullscreen on one share unsubscribes every other share; leaving fullscreen does nothing automatic. When the share stops for any reason (sharer quit, peer unreachable, viewer left the call) fullscreen ends with it. iPhone Safari has no element fullscreen and falls back to the native video player (2026-09-08).
- Tile states: not watching shows "click to watch" (no preview, no frames flow); subscribing shows a spinner until the first frame; live shows video with a stats bar of rounded bitrate, received resolution and frame rate, and direct or relayed; the sharer's own tile shows viewer count, total upload and every distinct encoded resolution and frame rate (viewers on small screens get a scaled copy); unreachable dims the tile with "no connection to X". In fullscreen the bar also carries the local volume slider for that participant.
- A re-join after the sharer's own server reconnect carries `sharing: true` in the join message, so the presence flag, and with it every viewer's subscription, survives the reconnect.
- Mobile viewing: `<video autoplay playsinline muted>` fed by the received track; voice on a separate audio element with `play()` awaited and a play button on `NotAllowedError`; take a Screen Wake Lock while watching.

## 7. User interface

From [Room UI prototype: visitor and participant views](issues/11-room-ui-prototype.md). Reference implementation of the layout: branch `prototype/room-ui`, variant D (throwaway; rewrite properly).

### 7.1 Layout
- Two columns on desktop: a fixed-width presence sidebar on the left, one main column on the right.
- Sidebar: **Online** (visitors) first, then **Call** (participants). The user is listed last in Online and first in Call, so joining moves their own entry one slot. Entries show avatar initial, name, fingerprint, "new" badge, and for participants the muted and sharing flags plus the connection badge.
- Sidebar actions under the Call list, each full width on its own row: Join for a visitor; Mute, Share screen, Leave for a participant. Share screen becomes a "not available on this device" hint where `getDisplayMedia` is missing. A name-clash warning sits under the actions.
- Main column: chat fills it entirely while nobody shares. When at least one share exists it splits horizontally: shares side by side in one equal-width row on top (about the upper half), chat below. Chat is always visible, never a drawer.
- Visitors see share tiles marked "join to watch".

### 7.2 State shown, always
- Per-peer connection badge: direct, via relay, reconnecting, unreachable (§8.2). Never hidden.
- Server socket state as a full-width banner above everything when not connected: "Reconnecting to server… voice and shares continue, chat is paused", then after 30 s "Server unavailable, retrying".
- Chat input disabled with a reason while disconnected; a line notes possibly missed messages after reconnect.

### 7.3 Phone width
One column, the whole page scrolls, the presence list has no max height and never clips, shares stack vertically above the chat. No tabs.

### 7.4 Attention cues
Title badge such as "(3 in call)" while the tab is unfocused, short join and leave chimes, and a softer two-note cue for other people's messages (added 2026-09-07). No system notifications.

### 7.5 Mobile promise
Best effort: "works on recent iOS Safari and Android Chrome, not a supported target". Voice, text, and viewing shares; no publishing.

### 7.5 Problem reports (2026-09-08, ticket 12)
A "Report a problem" link at the bottom of the sidebar opens a dialog: a description, then Send or Copy. Send captures one PostHog event `bug_report` carrying the text and a technical snapshot of the tab: server status, people counts, the caller's own fingerprint, per peer the connection, ICE, signaling and gathering states, the selected candidate pair type, the share track state, inbound video counters (frames received, decoded, dropped, key frames, PLI/FIR/NACK, freezes, decoder, codec) and outbound video counters for the sharer, the share tiles' video elements (ready state, size, paused, frames shown), and the last 40 console warnings. Never message texts or names. The event sits next to the tab's masked session replay. Copy puts the same as text on the clipboard for browsers that block PostHog (Brave Shields, strict tracking protection). A tile that has been live for 4 s without showing a frame files `share_black` automatically with the same per-peer snapshot, re-attaches the element's source and re-subscribes so the sharer restarts the encoding with a fresh key frame; at most two rounds per subscription.

### 7.6 Layout (2026-09-09)
The room is one CSS grid: the sidebar spans every row on the left; shares, chat log and composer are three rows of the right column, the composer being its own grid item. Rare actions ("Report a problem", "Clear chat history", the latter behind a confirm) sit in a footer pinned to the bottom of the sidebar, far from anything clicked often. On phones (one column, the page scrolls as a whole) the composer is pinned to the bottom of the screen (`position: fixed`, safe-area aware) and the viewport declares `interactive-widget=resizes-content` so an open keyboard shrinks the layout instead of covering it. Server-state notices float as a pill from the top edge of the main column and never move the layout.

## 8. Failure and reconnection

### 8.1 Server socket
Client keeps peer connections alive, reconnects with exponential backoff capped at 30 s, redoes the challenge, and re-declares role, sharing, and muted. The server treats it as a fresh socket; the polite role does not depend on anything that changed (§2.2). Presence is frozen and dimmed meanwhile; text is disabled.

The other participants keep their media connection to a friend who vanished from presence without an explicit `left` for a 60 s grace period, showing them dimmed as "connection to server lost", so the friend's reconnect does not interrupt voice. After the friend rejoins, connections that died meanwhile are rebuilt by the rejoiner, who now holds the highest join sequence. (Added 2026-09-06 while building ticket 04; confirmed by the owner the same day.)

A peer that vanished from presence and whose media then fails or disconnects is closed at once rather than after the grace period: their socket is gone, so an ICE restart could not be signalled anyway and only produced "not in the call" errors. They re-offer when they return (2026-09-08).

### 8.2 Peer connections
Per connection, read `getStats` every 2 s. The selected candidate pair's type gives direct versus relayed. ICE state maps to the badge: connected or completed is direct or relayed; disconnected is "reconnecting" and triggers an ICE restart after 5 s; failed is "unreachable" and retries ICE restart with backoff. **Server presence wins**: a failed peer link never removes anyone from the Call; only an explicit leave or a dead socket does.

Stuck-connecting watchdog (2026-09-08): a connection still "connecting" after 15 s (offerer) or 20 s (answerer, staggered so both do not act at once) reports `peer_connecting_slow` with signaling, ICE and gathering state, description presence and candidate counts, then tears the connection down and offers again itself; perfect negotiation resolves a collision if both sides do. Delay doubles per attempt up to 60 s and resets on success. Root cause found on 2026-09-08: a ghost socket listed as visitor ahead of the live participant made the server reject offers to that person ("not in the call"), leaving the offerer in "connecting" until the ghost was swept or the page reloaded.

### 8.3 Object eviction and restart
The room object may be evicted at any quiet moment. Everything is rebuilt from attached sockets and attachments on wake; there is nothing else to lose. Text typed while a client was disconnected is gone by design.

## 9. Free-tier limits and consequences

From [Free hosting for an always-on WebSocket hub and static SPA](issues/03-free-hosting-websocket-hub.md) and the hosting decision.
- Workers: 100,000 requests/day, 10 ms CPU per invocation. Static asset requests are free and unlimited when not routed through the script.
- Durable Objects: 100,000 requests/day, 13,000 GB-s/day duration, incoming WebSocket messages counted 20:1, outgoing free, hibernating objects accrue no duration. One never-hibernating object costs 10,800 GB-s/day, so even a 24-hour call fits. Exceeding a limit makes operations fail with an error, no bill; the room is dead until the daily reset. The per-socket rate limit (§4) and the ban on speaking indicators over the socket are what keep a broken client from taking the room down.
- TURN: 1,000 GB/month egress free, then $0.05/GB with no hard cap. Accepted: that is roughly 900 hours of one fully relayed screenshare a month. A $1 budget alert is set (informational only). Credentials are revoked on leave and expire after 12 hours.
- Card: a payment method sits on the Cloudflare account. Workers and Durable Objects cannot bill on Free; TURN can.

## 10. Out of scope

Deliberately not part of this effort (see the map's Out of scope section for reasons): multiple rooms or channels; camera video; persistent text history in any form; accounts, allowlists, or third-party sign-in; visitor visibility with an invisible mode; any server that handles media; identity recovery or key linking across browsers; push-to-talk; system notifications; first-frame preview thumbnails on share tiles.

## 11. Implementation notes and order

- Build the runtime-neutral signaling core first with tests in workerd; the mesh spike on branch `prototype/mesh-spike` is a working reference for negotiation, transceiver adoption, subscription toggles, and the settings calls.
- Then the SPA shell with presence and text (a visitor can chat before any WebRTC exists).
- Then voice, then shares, then share settings and connection badges.
- Rewrite both prototypes rather than promoting them; they were written under prototype constraints.
- Research findings with sources live on the `research/*` branches under `docs/research/`, linked from tickets 01 to 06.
