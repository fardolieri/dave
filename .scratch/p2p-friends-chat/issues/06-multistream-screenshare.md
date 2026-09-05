# Multiple simultaneous screen shares in a WebRTC mesh

Type: research
Status: resolved
Blocked by: none

## Question

How should several participants share screens at once, with each other participant choosing which shares to view, in a WebRTC mesh? Record: getDisplayMedia support and options (surface choice, audio capture, frame rate and resolution constraints) on desktop Chromium, Firefox, and Safari, and on iOS Safari and Android Chrome; whether a viewer can subscribe to and unsubscribe from a share without renegotiating the whole connection (transceiver direction, track replacement); bandwidth implications of N sharers in a mesh of 5 and of 8; and what viewing a share needs on mobile. Answer from MDN, W3C specs, and browser compatibility data. Findings to `docs/research/multistream-screenshare.md`.

## Answer

**Multiple simultaneous shares work in a mesh, with each viewer opting in per share, but only if the sharer stops encoding for peers who are not watching. Publishing a share is desktop-only. Share audio is Chromium-only and best-effort.**

- **Cost model**: each Share is one video track. In a mesh the sharer sends it separately on every peer connection: N-1 encodes and N-1 uploads per Share. libwebrtc caps a screen-share stream at 2.5 Mbps by default. With everyone watching everything, a sharer uploads up to 10 Mbps in a call of 5 and 17.5 Mbps in a call of 8. A viewer downloads 2.5 Mbps per Share watched. Selective viewing plus per-connection `maxBitrate` is what keeps 8 tolerable.
- **Subscribe and unsubscribe without renegotiation**: the viewer asks the sharer, over signaling, to flip `encodings[0].active` via `setParameters()` or to `replaceTrack(null)` / `replaceTrack(track)` on the sender for that one peer connection. Changing `transceiver.direction` triggers `negotiationneeded` and is the slow path. Starting a new Share still needs one renegotiation per peer.
- **Publishing**: `getDisplayMedia()` works on desktop Chromium 72+, Firefox 66+, Safari 13+. Absent on iOS Safari, Android Chrome, Android Firefox. Chrome's picker options (`displaySurface`, `systemAudio`, etc.) are desktop-only hints and cannot narrow the user's choice.
- **Share audio**: Chromium only. Tab audio on every desktop OS, whole-system audio only on Windows and ChromeOS when a screen is shared. Firefox (bugzilla 1541425, open) and Safari return no audio track. The spec makes audio optional, so treat it as best-effort with a visible "no audio" indicator.
- **Viewing on mobile**: a plain `<video autoplay playsinline muted>` fed by a normal WebRTC receive works. Recommend the sharer downscale that peer via `scaleResolutionDownBy` and the viewer take a Screen Wake Lock (Chrome 84, Firefox 126, Safari 16.4, iOS Safari 18.4).
- **Opus** default 32 kbps, so voice is negligible next to shares.
- Unverified: Firefox and Safari default screen-share bitrates.

Consequence for the map: the voice and share behaviour ticket should decide a cap on concurrent shares or on shares watched per viewer, and the stack decision must include a signaling message for "start/stop sending share X to me". Mobile scope sharpens to: voice, text, and viewing shares work; publishing a share does not exist there. Share audio moves from fog to a settled fact: offer it, expect it only on Chromium.

Findings (with sources): `docs/research/multistream-screenshare.md` on branch `research/multistream-screenshare` (commit 87c9f97). Read with `git show research/multistream-screenshare:docs/research/multistream-screenshare.md`.
