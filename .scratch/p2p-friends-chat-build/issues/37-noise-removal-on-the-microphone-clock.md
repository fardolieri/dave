# 37 · Noise removal on the microphone's clock, and a guard that stops it when the voice runs off time

Status: built 2026-10-02 on `build/37-noise-removal-clock`, not shipped
Asked for 2026-10-02: Daniel: "a different friend is in the chat with me right now and sounds similar weird as last time."
The receive side was clean every time (no loss, jitter under 10 ms), and a bigger buffer would not have helped. What
was wrong was how much voice arrived. With noise removal on, three friends sent more voice than real time, and Daniel's
Chrome buffered it and played it sped up. Turning noise removal off fixed it each time, within a minute (Daniel: "he
sounded much better").

| friend (`voice_quality` on Daniel's side) | packets per 30 s (1500 = real time) | buffer | sped up |
|---|---|---|---|
| 6yzuqh, device unknown | 1620–1830 | 1.5–2.5 s | 6–16 % |
| 7bsj5u, GrapheneOS Vanadium, JIT off, USB-C headset | up to 1606 | 2 s | 9 % |
| 7bsj5u, same, JIT on | 1521–1547 | up to 850 ms | 0.5–3.3 % |
| xchxyp, Pixel 5 GrapheneOS Vanadium, JIT on, AUX headset | 1500 | 80 ms | 0 % |

Two causes on the sending side. Vanadium runs WebAssembly through its DrumBrake interpreter while JIT is off, and
RNNoise there stalled and burst. Even with JIT on, the USB-C headset still drifted, because the noise removal of ticket
26 runs in an AudioContext of its own, which keeps time by the output device, not the microphone. The 2026-10-01
"stutter-ish" Brave/Linux friend (5rwpz6) had clean receive stats too and is probably the same pipeline; not confirmed.

## Built
- `client/voice.worker.ts`, `client/voice.ts`: a second path, `frames`, wherever the page has MediaStreamTrackProcessor,
  MediaStreamTrackGenerator and AudioData (Chromium: Chrome, Brave, Vanadium). The microphone's readable and the
  generator's writable go to a dedicated worker. It takes each frame (first channel, f32), resamples it to 48 kHz if the
  microphone runs at another rate, runs RNNoise and the gate on 480-sample frames, and writes them out with timestamps
  in 10 ms steps from the first frame's. The generator track is what peers get. Until RNNoise is ready the frames pass
  through; once a second of audio the worker reports its load (processing time over audio time). A microphone switch
  sends the worker a new readable. Firefox and Safari keep the `context` path (the worklet). `VoiceProcessor.path`
  says which one runs.
- `client/denoise.ts`: RNNoise loading and the per-frame processor (gate, ramp, level reports), moved out of the worklet
  and shared by both paths.
- `core/voiceclock.ts` (unit-tested): `createResampler` (linear, carries the phase across chunks); `createVoiceGuard`,
  fed once a second with wall time, the audio the track has delivered, and the load. It stops noise removal when the
  voice is more than 2 % off real time over 10 s for three readings in a row (`drift`), or the load stays at 80 % or more
  for 5 readings (`overload`). It ignores the first 3 s and starts over when no audio advanced. `sendRatePct`.
- `client/call.ts`: `clockTick` once a second in a call with a friend reads the sent track's
  `stats.deliveredFramesDuration` (Chromium) and feeds the guard while the processed voice goes out. A fault calls
  `removalFailed` with the reason, so the microphone goes out as it is and the browser's noise suppression comes back.
  Noise removal stays off for the tab until the setting is switched off and on, the rule of ticket 26.
  `noiseRemovalStop` tells the panel why. PostHog: `voice_send` every 30 s (`rate_pct`, `seconds`, `noise_removal`,
  `path`, `load_pct`, `load_max_pct`, `mic_rate`, `peers`; muted time is not measured, as a disabled track delivers nothing); `noise_removal_unavailable` gets `path`,
  `rate_pct`, `load_pct`, `mic_rate` for `drift` and `overload`. Problem reports: `audioProcessing` adds `path`, `stop`,
  `loadPct`, `micRate`. Hook: `audio` adds `path`, `stop`, `load`, `deliveredMs`; `skewVoiceClock(factor)` scales what
  the guard reads.
- `App.tsx`: the panel note says why noise removal stopped (too fast or too slow, or could not keep up) instead of
  "cannot run in this browser".
- Spec §6.1 (noise removal on the microphone's clock); `CONTEXT.md`: Noise removal.

## Verify
- `pnpm typecheck`, `pnpm test` (voiceclock: resampler counts and chunk edges, guard on 3 % fast, 5 % slow, the start,
  one stall, load spikes against sustained load, pauses, reset).
- Probe in Playwright's Chromium (`scratchpad/mstp-probe.mjs`): the fake microphone gives 480-frame f32-planar chunks at
  48 kHz; 300 frames through a worker took 2995 ms; the generator track counts what it delivers. Latency
  (`scratchpad/latency-probe.mjs`, each track to a peer connection): the microphone averaged 241 ms (the fake device),
  the `frames` path 264 ms, so about 20 ms more.
- `E2E_FIREFOX=1 pnpm e2e`: the noise removal test of ticket 26 passes on both paths (Chromium `frames`, Firefox
  `context`). New test "noise removal keeps time with the microphone…": Chromium sends the processed voice at
  0.95–1.05 of real time; with `skewVoiceClock(1.05)` the guard stops noise removal within 30 s, the microphone goes out,
  the panel says why, Bob still hears Alice, and switching it off and on brings it back. Firefox checks its path and
  skips the clock part (no track stats).
- Full suite, both engines: 106 passed, 7 skipped, 1 failed: "ticket 23: join and leave cues…" in Firefox ("Alice
  hears a cue" never came). Not this ticket: it failed 2 of 3 on this branch and 1 of 3 on master in a worktree; the
  cue plays on the playback context, which neither path touches. The noise removal tests passed 3 of 3 in both engines.
- Not tried: the USB-C headset on Vanadium, the friend who showed it. That is the real test: noise removal on, and his
  `packets` per 30 s on the receiving side at 1500, `accel_pct` near 0, his own `voice_send` `rate_pct` near 100.

## Open
- 7bsj5u's phone sends only page-load events (`$pageview`, `$identify` or `room_entered`), then nothing: no
  `call_joined`, no `voice_quality`, now no `voice_send` either, though he opted in. Not visible from PostHog; it needs
  his console (`chrome://inspect` over USB).
