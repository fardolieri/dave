# 05: Screen share with subscriptions

**What to build:** A participant clicks Share screen, picks a window, and everyone sees a tile appear in a share row above the chat. Nothing flows until a viewer clicks the tile; then that viewer, and only that viewer, receives the share. Two people can share at once. Fullscreen on one share stops receiving the others. Visitors see the tiles marked "join to watch".

**Blocked by:** 04 Join a call with voice.

**Status:** in-progress (branch `build/05-shares`, under review)

- [x] Share screen calls the display picker with audio requested, system audio included where offered, own tab excluded, surface switching allowed; the track's end (button or browser control) stops the share and announces it.
- [x] Start is `replaceTrack(track)` on the share transceivers of every connection, stop is `replaceTrack(null)`; no offer/answer during a call; one share per participant.
- [x] After attaching, the sharer deactivates the share encodings for every peer that has not subscribed, waiting until each sender has encodings (retry every 100 ms).
- [x] Subscribe and unsubscribe messages toggle `encodings[0].active` on the sharer's connection to that viewer; bitrate to unsubscribed peers measured at zero in a test with stats.
- [x] Main column splits when at least one share exists: equal-width tiles in one row above the chat; chat fills the column otherwise. Tiles render from signaling state, not track events.
- [x] Tile states: join to watch (visitor), click to watch, spinner until first frame, live with bitrate and direct or relayed caption, own share preview, unreachable dimmed.
- [x] Fullscreen button per tile; entering fullscreen unsubscribes all other shares; leaving does nothing automatic.
- [x] Default bandwidth rule: 8 Mbps budget per share split across active viewers, ceiling 2.5 Mbps, floor 1 Mbps, applied as `maxBitrate` per connection as subscriptions change.

## Notes

- 2026-09-06: built on branch `build/05-shares`. 50 tests in workerd: share flag through presence, subscribe relayed to the sharer tagged with the viewer's key, leaving clears sharing, visitors refused, bandwidth rule values.
- Verified with three headless Chromium profiles via `scripts/drive.mjs --join --share` (fake screen source): Alice's share produced zero inbound video bytes at Bob and Carol until Bob clicked the tile; then Bob received about 150 KB in five seconds and Carol still zero; Bob's tile showed "307 kbps · direct"; Alice's own tile showed "you are sharing". Two sharers at once: Carol watched both with live captions, then unsubscribed from Alice and her byte count from Alice froze while Bob's kept growing; Alice's tile returned to "Click to watch".
- Bitrate caps: `perViewerBitrate` (8 Mbps budget, 2.5 Mbps ceiling, 1 Mbps floor) is applied as `maxBitrate` to every current viewer whenever the viewer set changes.
- "Live" on a tile follows the received video track's unmute/mute events, so a viewer knows frames are actually arriving rather than trusting the subscription.
- Fullscreen: the button calls `watchOnly` (unsubscribes every other share) before `requestFullscreen`; leaving fullscreen does nothing. Not exercised headlessly (needs a user gesture); reviewed only.
- Share audio: requested with `systemAudio: 'include'`; attached to the third transceiver when the browser provides a track. Not exercised headlessly.
- Tests in this repo do not exercise WebRTC itself; the mesh spike and the browser driver do.
