# 06: Share, audio, and device settings

**What to build:** A sharer opens the gear next to Share screen and picks Motion or Detail, or tunes frame rate, resolution, degradation preference, and bandwidth by hand, and the live share changes without interruption. A viewer can turn on low latency. Anyone can pick microphone and speaker and, behind a warning, change audio processing. All of it is remembered per browser.

**Blocked by:** 05 Screen share with subscriptions.

**Status:** ready-for-agent

- [ ] Presets: Motion (60 fps, scaled to about 720p, content hint motion, degradation maintain-framerate) and Detail (15 to 30 fps, native, content hint detail, maintain-resolution); default Detail at 30 fps.
- [ ] Advanced controls: frame rate 15/30/60, resolution native/1080p/720p, degradation preference, upload budget and per-viewer ceiling; frame rate and resolution via `applyConstraints` on the live track, encodings via `setParameters` per peer; a small-screen viewer's request applies `scaleResolutionDownBy` for that peer only.
- [ ] Viewer low-latency toggle sets `jitterBufferTarget` on share receivers.
- [ ] Audio settings popover: echo cancellation, noise suppression, automatic gain toggles behind a warning banner; microphone and speaker pickers using the customizable select where supported with a plain select fallback; speaker selection only where the browser supports output devices.
- [ ] All settings persist per browser and re-apply on next visit.
