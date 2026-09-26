# 26 · Noise removal and the voice gate

Status: built 2026-09-26 on build/26-noise-removal
Asked for 2026-09-26: "Do we already have a custom minimum threshold of microphone activity in place? … How complicated
is it to make it configurable for the user with live microphone feedback?" The only threshold was the speaking ring's
RMS 0.02; nothing gated what was sent. Research (`docs/research/noise-suppression.md`, branch `research/noise-suppression`)
and a spike (branch `prototype/noise-spike`) compared RNNoise, GTCRN and DeepFilterNet; Daniel picked RNNoise with the
current model by ear ("sounds good and suppresses the right things", about 30 ms), then xiph's "little" model from our
own build ("as perfect as number 2") at about a quarter of the CPU. Decisions: on by default on all devices, phones too;
gate on voice probability only, threshold 0.5, hold 300 ms; one "Voice gate" slider with a live meter; my speaking ring
follows the gate; the raw microphone whenever it cannot run; the built wasm committed.

## Built
- `scripts/build-rnnoise.sh`: xiph RNNoise 70f1d25 with the little model, emsdk 6.0.10, `-msimd128 -mavx` (RNNoise's
  own AVX path translated to wasm SIMD), standalone wasm with a 1 MB stack. Output committed as
  `client/rnnoise/rnnoise-little.wasm` (5.7 MB) with xiph's `COPYING`.
- `core/voicegate.ts`: the gate as a pure state machine (opens on a frame at or over the threshold, holds 300 ms,
  threshold 0 keeps it open). `core/settings.ts`: `noiseRemoval` (default on), `voiceThreshold` (0 to 0.95, default
  0.5), `captureProcessing` (browser noise suppression off while noise removal runs), `processingIsDefault` counting
  noise removal as the noise suppression.
- `client/voice.worklet.ts`: RNNoise on 480-sample frames through a FIFO, the gate with a one-frame attack and a 60 ms
  release, level reports 20 times a second; passes input through until RNNoise is ready.
- `client/voice.ts`: its own `AudioContext` at 48 kHz, so the playback context keeps the browser's rate and a browser
  that refuses 48 kHz (Firefox before 148 with a microphone at another rate) loses only noise removal. The wasm is
  fetched once per tab and handed to the worklet as bytes; no emscripten JS, no fetch inside the worklet.
- `client/call.ts`: peers get the processed track once RNNoise runs and its context plays, the microphone's own track
  before that, after a failure, and while the context is suspended (switched by `replaceTrack`, no renegotiation).
  A microphone switch feeds the processor the new stream and leaves the sent track alone. Mute disables both tracks.
  Turning noise removal on or off works mid-call. My ring shows the gate while the processed voice goes out. PostHog:
  `noise_removal_unavailable` with the reason. Problem reports carry the state and the threshold.
- `App.tsx` Audio panel: "Noise removal" toggle, "Voice gate" slider whose thumb is the mark on the live meter (blue
  while open), a note when it cannot run; the browser's "Noise suppression" box is disabled while noise removal runs.
- Spec §6.1 amended; `CONTEXT.md`: Noise removal, Voice gate.
- `e2e/browsers.ts`: Firefox's "Script terminated by timeout at: process@…voice.worklet" is environment noise. Firefox
  interrupts the worklet while tearing a page down (a reload or navigation, most times); 60 s of steady processing logged
  none. Stopping the worklet or closing its context on `pagehide` did not win the race (tried both, 11 of 20 reloads).

## Verify
- `pnpm typecheck`, `pnpm test` (gate and settings tests), `pnpm build`.
- `E2E_FIREFOX=1 pnpm e2e` (Chromium and Firefox): new test "noise removal runs on the outgoing voice, the gate
  follows its slider, and switching it off sends the microphone again"; the processing-warning test updated.
- WebKit (Playwright's build, in its container) against `pnpm dev`: joined, noise removal `on`, the processed track
  sent, the gate shut on the fake microphone's tone; that microphone runs at 44.1 kHz, so the 48 kHz context resamples.
- Not tried: a real Safari, a phone (CPU there unmeasured).
