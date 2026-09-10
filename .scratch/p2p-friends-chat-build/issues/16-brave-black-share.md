# 16 · Black share tile on Brave: the video element never starts

Status: resolved
Reported 2026-09-10 by a friend on Brave (Linux): "I wasn't able to see a shared monitor. I just see a black rectangle." PostHog session `01a08c7b-f24a-7ef8-9f97-11eca67db33a`, events `share_black` 18:04:09 UTC and `bug_report` 18:05:09 UTC.

## What the data said
- WebRTC was healthy: direct host-to-host pair, 286 → 369 frames received and decoded, 0 lost, VP8 via libvpx, share track live and unmuted.
- The `<video>` element: `readyState 4`, 666×720, `paused: true`, 83 frames delivered and 82 dropped. It never played. The report counted `black_tiles: 0` because the heuristic did not look at `paused`.
- The black check's nudge (`play()` 4 s after live) was refused silently: every `play()` rejection was swallowed with an empty catch.

## Cause (reproduced in headless Brave 1.94 via Flatpak, autoplay site setting on Block)
Brave's default for autoplay is Allow, so the friend has it on Block. Brave patches Blink's autoplay policy (`chromium_src/third_party/blink/renderer/core/html/media/autoplay_policy.cc`): with the setting on Block, `IsGestureNeededForPlayback` returns true unconditionally, which defeats Chromium's muted-video and MediaStream exemptions, and as a side effect `IsAutoplayAllowedForFrame` calls `frame->ClearUserActivation()`. Three things then conspired:
1. The tile relied on the `autoplay` attribute; Brave ignores it, and nothing called `play()` until the black check 4 s later, outside the 5 s activation window.
2. `attention.ts` called `AudioContext.resume()` on every `pointerdown`; that consults the policy, so the activation was already cleared when the tile's `click` handler ran (`navigator.userActivation.isActive === false` inside the click).
3. A paused `<video autoplay>` re-checks the policy when activation arrives, which cleared it as well; with the attribute present not even a `play()` first thing in the click handler succeeded.

Two latent bugs surfaced on the way: the two-argument `createEffect` reruns whenever a dependency updates even if the computed value is equal, so the black check's timer was re-armed on every stats tick and rarely fired; and Firefox reports `totalVideoFrames: 0` for a MediaStream, so the check would flag every Firefox viewer once it did fire.

## Fix
- `App.tsx` ShareTile: no `autoplay` attribute; explicit `play()` in the click that starts watching, on live, on own capture, after a source reset; refusals logged (`share video play() refused (<why>, gesture <bool>)`) and a "Click to play" note whose click plays. Live and running transitions go through memos. Presented frames counted with `requestVideoFrameCallback` and mirrored to `data-frames`.
- `attention.ts`: the audio unlock listens on `click` (bubble phase, after the tile) and `keydown`, and unregisters once the context runs.
- `core/report.ts`: `isBlackTile` also counts a paused element; `diagnostics.ts` reads `data-frames`.
- `scripts/drive.mjs`: `BROWSER_<NAME>`, `PROFILE_DIR`, `AUTOPLAY_BLOCK`, `BLACK_CHECK=1|nogesture` (real mouse click, brightness probe of the video element, own-tile probe).

## Verified 2026-09-10 (sharer: headless Chromium; viewer as listed; brightness ≈ 50 means the fake capture is painted, 0 is black)
- Brave 1.94 autoplay Block, real click: playing, brightness 50, 0 dropped, no refusals. Before the fix: paused, brightness 0 for 15 s.
- Brave autoplay Block, watch started without a gesture: "Click to play", then playing after one real click.
- Brave default, Google Chrome 153 (Flatpak), Firefox (Playwright build) default: playing from the first click.
- Firefox with `media.autoplay.default=5`, `blocking_policy=2`: playing from the click; recovery via "Click to play" works.
