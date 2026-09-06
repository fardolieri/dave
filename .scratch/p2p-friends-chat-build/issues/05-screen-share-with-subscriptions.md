# 05: Screen share with subscriptions

**What to build:** A participant clicks Share screen, picks a window, and everyone sees a tile appear in a share row above the chat. Nothing flows until a viewer clicks the tile; then that viewer, and only that viewer, receives the share. Two people can share at once. Fullscreen on one share stops receiving the others. Visitors see the tiles marked "join to watch".

**Blocked by:** 04 Join a call with voice.

**Status:** ready-for-agent

- [ ] Share screen calls the display picker with audio requested, system audio included where offered, own tab excluded, surface switching allowed; the track's end (button or browser control) stops the share and announces it.
- [ ] Start is `replaceTrack(track)` on the share transceivers of every connection, stop is `replaceTrack(null)`; no offer/answer during a call; one share per participant.
- [ ] After attaching, the sharer deactivates the share encodings for every peer that has not subscribed, waiting until each sender has encodings (retry every 100 ms).
- [ ] Subscribe and unsubscribe messages toggle `encodings[0].active` on the sharer's connection to that viewer; bitrate to unsubscribed peers measured at zero in a test with stats.
- [ ] Main column splits when at least one share exists: equal-width tiles in one row above the chat; chat fills the column otherwise. Tiles render from signaling state, not track events.
- [ ] Tile states: join to watch (visitor), click to watch, spinner until first frame, live with bitrate and direct or relayed caption, own share preview, unreachable dimmed.
- [ ] Fullscreen button per tile; entering fullscreen unsubscribes all other shares; leaving does nothing automatic.
- [ ] Default bandwidth rule: 8 Mbps budget per share split across active viewers, ceiling 2.5 Mbps, floor 1 Mbps, applied as `maxBitrate` per connection as subscriptions change.
