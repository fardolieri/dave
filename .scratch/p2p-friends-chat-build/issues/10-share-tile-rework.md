# 10 · Share tile rework: click semantics, own fullscreen stage, stats, stuck-sharing fix

Requested 2026-09-08 after real use.

## Asked
- Click on an unwatched tile starts watching (kept). Click on a running tile enters fullscreen instead of unsubscribing. Click anywhere in fullscreen leaves it.
- No pause control in fullscreen (meaningless for a live stream), keep volume and exit.
- Dedicated button to stop receiving a share. Fullscreen button, if kept, bottom right.
- Sharer sees outgoing bitrate (rounded) plus resolution and frame rate of every distinct encoding.
- Viewer sees received resolution and frame rate next to bitrate and direct/relayed.
- Bug: leave while sharing, rejoin, UI still says sharing.

## Decisions
- The tile element goes fullscreen, not the `<video>`. Browsers attach their own playback controls (with pause) to a fullscreen video and offer no way to drop just the pause button, so the tile becomes the stage and our header and stats bar overlay it. The stats bar in fullscreen also carries the local volume slider for that participant (their voice and share audio), replacing the browser's volume control, which only ever acted on a muted element anyway.
- iPhone Safari has no element fullscreen; it falls back to the native video player, controls included.
- Stats come from `getStats()` every 2 s: inbound-rtp `frameWidth`/`frameHeight`/`framesPerSecond` for the viewer, outbound-rtp per viewer for the sharer, summed and de-duplicated (`distinctFormats`).

## Bug findings
- PostHog showed the Firefox sessions with `call_left` after `screen_share_started` and no `screen_share_stopped`. `stopShare` awaited `replaceTrack(null)` per sender; `leave` closed the connections right after; Firefox never settles that promise, so `setSharing(null)` never ran and `stoppingShare` stayed true until reload. Fix: all UI-visible state resets synchronously, the sender detach is fire-and-forget.
- Related: `rejoinAfterReconnect` re-declared join, which reset the server-side sharing flag; every viewer's tile went back to "click to watch" while the sharer kept sending. The join message now carries `sharing`.

## Notes
- Driver: `FULLSCREEN_CHECK=1` and `LEAVE_CHECK=1` cover the new click semantics, the stop button, auto-exit and the leave/rejoin path.
