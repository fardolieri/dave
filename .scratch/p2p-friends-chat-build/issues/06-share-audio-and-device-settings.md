# 06: Share, audio, and device settings

**What to build:** A sharer opens the gear next to Share screen and picks Motion or Detail, or tunes frame rate, resolution, degradation preference, and bandwidth by hand, and the live share changes without interruption. A viewer can turn on low latency. Anyone can pick microphone and speaker and, behind a warning, change audio processing. All of it is remembered per browser.

**Blocked by:** 05 Screen share with subscriptions.

**Status:** in-progress (branch `build/06-settings`, under review)

- [x] Presets: Motion (60 fps, scaled to about 720p, content hint motion, degradation maintain-framerate) and Detail (15 to 30 fps, native, content hint detail, maintain-resolution); default Detail at 30 fps.
- [x] Advanced controls: frame rate 15/30/60, resolution native/1080p/720p, degradation preference, upload budget and per-viewer ceiling; frame rate and resolution via `applyConstraints` on the live track, encodings via `setParameters` per peer; a small-screen viewer's request applies `scaleResolutionDownBy` for that peer only.
- [x] Viewer low-latency toggle sets `jitterBufferTarget` on share receivers.
- [x] Audio settings popover: echo cancellation, noise suppression, automatic gain toggles behind a warning banner; microphone and speaker pickers using the customizable select where supported with a plain select fallback; speaker selection only where the browser supports output devices.
- [x] All settings persist per browser and re-apply on next visit.

## Notes

- 2026-09-06: built on branch `build/06-settings`. Settings live in `src/core/settings.ts` as plain data with presets and derived WebRTC parameters (unit-tested, 53 tests total); the call manager applies them live: `applyConstraints` and `contentHint` on the capture track, `maxBitrate`/`maxFramerate`/`scaleResolutionDownBy`/`degradationPreference` per viewer connection, microphone re-capture plus `replaceTrack` on device change, processing toggles via `applyConstraints` on the voice track, speaker via `setSinkId` on every audio element where supported, `jitterBufferTarget` on share receivers.
- Verified with the browser driver: flipping to the Motion preset mid-share moved the live capture to 1280x720 at 60 fps with the motion hint and the active viewer's sender to 60 fps with maintain-framerate; a non-viewer's inactive sender was left untouched until it subscribes.
- Small screens (max-width 700px) ask sharers for a 2x downscale on subscribe (`scale` on the subscribe message, relayed as is); the sharer applies `scaleResolutionDownBy` for that connection only.
- Device pickers use `appearance: base-select` with `::picker(select)` styling where supported and fall back to the native select elsewhere.
