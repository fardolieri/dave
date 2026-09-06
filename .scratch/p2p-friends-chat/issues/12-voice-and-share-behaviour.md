# Voice and share behaviour

Type: grilling
Status: resolved
Blocked by: 06, 07, 11

## Question

Pin down the user-facing behaviour of voice and shares. Decide: mute and unmute, push-to-talk or voice activity, input and output device selection, noise suppression and echo cancellation settings, speaking indicators; how a participant starts and stops a share and whether share audio is captured; how a viewer opens and closes a share and whether they can view several at once; caps on concurrent shares given the mesh bandwidth research; and what is hidden or disabled on mobile.

Requirement from [Presence and ephemeral text transport model](09-presence-and-text-transport.md): decide how per-peer connection state is derived (selected candidate pair type from getStats, ICE connection state) and how often it is refreshed, so the UI can show direct versus relayed and unreachable honestly. Speaking indicators are computed locally from received audio, never sent over the socket.

Layout settled in [Room UI prototype: visitor and participant views](11-room-ui-prototype.md): shares render as one side-by-side row above the chat, sidebar actions are Mute, Share screen, Leave. This ticket decides the share-row sizing rules, any cap on shares watched at once, what a tile shows while subscribing, and the Mute and Share button semantics.

## Answer

Resolved 2026-09-06 by grilling. Browser support facts below are from MDN browser-compat-data read the same day.

**Voice**

1. **Activation**: always on with voice activity, plus a Mute button. No push-to-talk (out of scope).
2. **Join state and mute**: join unmuted, last mute state remembered per browser. Mute disables the local audio track (no renegotiation) and broadcasts "mute changed" for the sidebar badge.
3. **Processing and devices**: echo cancellation, noise suppression, and automatic gain default on. A settings popover exposes the three toggles **with a small warning banner** that changing them usually makes you sound worse to others, plus microphone selection and speaker selection where the browser supports output device choice. Device pickers use the customizable select (`appearance: base-select`, Chrome 135, Safari 27) for radio-style menu items, falling back to a plain select on Firefox, where it is behind flags as of 149. Choices remembered per browser.
4. **Speaking indicators**: local audio analyser on own mic and every received voice track, ring on the avatar past a threshold with a short hold. Nothing over the socket.

**Shares**

5. **Start and stop**: the Share screen button opens the display picker requesting video and audio, system audio included where offered, own tab excluded, surface switching allowed. Stopping is the button or the browser's own stop control, detected by the track ending, then announced.
6. **Share settings are first-class and tunable**, next to the Share button (gear), applied live without renegotiation and remembered per browser:
   - Two presets: **Motion** (game streams: 60 fps, resolution scaled down to about 720p, content hint `motion`, degradation preference `maintain-framerate`) and **Detail** (browsers and documents: 15 to 30 fps, native resolution, content hint `detail`, degradation preference `maintain-resolution`). Default is Detail at 30 fps.
   - Advanced controls: frame rate (15, 30, 60), resolution (native, 1080p, 720p), degradation preference (framerate, resolution, balanced), upload budget and per-viewer bitrate ceiling (see 7). Frame rate and resolution apply via `applyConstraints` on the share track, encoding limits via `setParameters` per peer.
   - Viewer-side low-latency option: `jitterBufferTarget` on the receiver (Chrome 124, Firefox 115, Safari 27), exposed as a "low latency" toggle in the viewer's own settings.
   - Support: `degradationPreference` Chrome 83, Firefox 138, Safari 12.1; `maxFramerate` Chrome 81, Firefox 101, Safari 11; `scaleResolutionDownBy` Chrome 74, Firefox 46, Safari 11. Whether `applyConstraints` changes frame rate and size on a live display-capture track in Firefox is unverified and is added to the mesh spike.
7. **Sharer bandwidth rule**: default upload budget 8 Mbps per share, divided equally among active viewers, per-viewer ceiling 2.5 Mbps, floor 1 Mbps, applied as `maxBitrate` on each viewer's connection as subscriptions change. Budget and ceiling are user-configurable in advanced share settings. A viewer on a small screen requests half resolution, applied for that peer only.
8. **Viewer behaviour**: any number of shares may be watched at once. Click a tile to subscribe, click again to unsubscribe. Each tile has a fullscreen button. **Entering fullscreen on one share unsubscribes every other share** to save bandwidth; leaving fullscreen does nothing automatic, the viewer re-clicks what they want. Tiles in the row stay equal width; no focus mode.
9. **Tile states**: not watching shows "click to watch" with no preview; subscribing shows a spinner until the first frame; live shows video with a caption of bitrate and direct or relayed; the sharer's own tile shows a "you are sharing" preview; unreachable dims the tile with "no connection to X". A low-resolution first-frame preview thumbnail for non-watchers is deferred (out of scope for this effort).

**Connection state and mobile**

10. **Derivation**: per peer connection, read stats every 2 s. Selected candidate pair type gives direct versus relayed. ICE connection state maps: connected or completed is direct or relayed; disconnected is "reconnecting" and triggers an ICE restart after 5 s; failed is "unreachable" and retries ICE restart with backoff while the participant stays in the call.
11. **Mobile**: best effort. Share button hidden where `getDisplayMedia` is absent. Voice and viewing work through normal WebRTC with a screen wake lock while watching. The spec says "works on recent iOS Safari and Android Chrome, not a supported target".

**Attention cues**

12. Title badge such as "(3 in call)" while the tab is unfocused, and short join and leave chimes. No system notifications (out of scope).
