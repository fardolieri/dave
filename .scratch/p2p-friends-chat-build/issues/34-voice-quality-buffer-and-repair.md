# 34 · Voice quality every 30 s, a buffer that follows the jitter, and voice repair (FEC, RED)

Status: in progress 2026-09-28
Asked for 2026-09-28: a friend on his phone "sounds weird stutterish". The two audio reports of Sep 26 predate the
voice stats in problem reports (ticket 27), so nothing measured it. Ticket 28 left the 200 ms buffer tied to low
bandwidth voice and named RED as the next step if a report showed lost packets. Decided with Daniel: three things, the
gate ruled out by him. (1) A `voice_quality` event every 30 s per friend while in a call, so the next stutter is
diagnosed without a report. (2) A voice buffer that rises by itself when the measured jitter or concealment is high.
(3) A "Voice repair" setting: Opus inband FEC (the browsers' default, made explicit), RED (a full copy of the previous
packet in every packet, about double the voice data), or off.

Measured first (loopback in Playwright's Chromium 2026-09-28, `scratchpad/red-probe.mjs`): Chrome and Firefox both
offer Opus with `useinbandfec=1` already. Chrome lists `audio/red` (fmtp `111/111`); Firefox does not. With RED first in
the codec order of the description a side *applies*, that side sends RED: about 143 bytes per packet against 80 with
plain Opus. `outbound-rtp` still names Opus as the codec, so RED shows in bytes per packet and in the SDP, not in the
codec stat. A side sends with the first codec of its *remote* description, so reordering the copy sent and the copy
applied (the way low bandwidth voice rewrites the fmtp) makes it hold both ways from one side, whoever offers.

## Built
- `core/voicequality.ts`: `voiceWindow(prev, cur)` turns two reads of the voice receiver's `inbound-rtp` counters into
  a window: seconds, packets, loss percent, audible concealment percent (concealed minus silent-concealed samples over
  all played), concealment events, jitter ms, the buffer held on average, stretching in and out percent, FEC packets,
  bytes per packet; null when no packet arrived. The buffer policy as a pure state machine: `nextBuffer` raises a step
  (200, then 400 ms) on a window with concealment from 3 percent or jitter from 50 ms, lowers a step after 12 clean
  windows (a minute), settles 2 windows after a raise, ignores windows under 40 packets. Unit-tested.
- `client/call.ts`: `sampleVoice` every 5 s per friend from the voice transceiver's receiver; `applyVoiceBuffer` now
  takes the larger of low bandwidth voice's 200 ms and the policy's step. PostHog: `voice_quality` every sixth sample
  with the 30 s window, `peer` (fingerprint), `conn`, `rtt_ms`, `buffer_target_ms`, `adaptive_ms`, `low_voice`,
  `voice_repair`, `sends_red`, `sends_fec`; `voice_buffer_adapted` on each change with the window that caused it;
  `voice_repair_changed`. Reports: `voiceBuffer` (step, last window), `sendsRed`, `sendsFec` per peer, `voiceRepair`;
  flat `voice_repair`, `peers_sending_red`, `max_adaptive_buffer_ms`. The `peers` hook shows `lastWindow`, `adaptiveMs`.
- `core/voicerepair.ts`: `voiceRepairSdp(sdp, mode)` on the copy sent and the copy applied (`voiceSdp` in call.ts,
  after low bandwidth voice's rewrite): RED first in the voice m-line for `red`; `useinbandfec=0` and RED last for
  `off`; nothing for `fec`. Only off touches the flag, no browser writes 0 by itself, and RED yields to an off from the
  other side. `sendsRed`, `asksFec` read a description. The section helpers (`voiceSection`, `rewriteVoice`,
  `withFmtpParams`) moved out of `core/lowvoice.ts`, whose `lowVoiceSdp` now uses them.
- `core/settings.ts`: `voiceRepair` ('off' | 'fec' | 'red', default 'fec'). Audio panel: a "Voice repair" radio row
  under Low bandwidth voice with a hover explanation. Spec §6.1; `CONTEXT.md`: Voice buffer, Voice repair.
- `e2e/fixtures.ts`: `deviceScaleFactor` for a friend, for phone-density screenshots.

## Verify
- `pnpm typecheck`, `pnpm test` (voicequality, voicerepair, settings, report, lowvoice tests).
- `E2E_FIREFOX=1 pnpm e2e`: two new tests in `e2e/settings.spec.ts`. "voice repair": bytes per voice packet grow by
  half at least on both sides once Alice picks RED (43 to 79 in Chromium, the gate shut on the fake microphone; the
  outbound codec stat still says Opus, so bytes per packet is the measure); Off drops the FEC flag from both applied
  descriptions and RED with it; Opus FEC brings the flag back. In the Firefox project Alice runs Firefox against a
  Chromium Bob: her RED changes nothing and nobody errors. "measured every five seconds": within 15 s the peers hook
  shows a window of Bob's voice with over 40 packets, under 3 percent concealment, and no buffer step on the local line.
- First run of the FEC part failed on my own rewrite: Bob's "Opus FEC" mode set the flag back to 1 on the copy he
  applied, overriding Alice's off. Fixed by letting only off touch the flag.
- The Audio panel at phone density (390 px wide, 3x) looked right before the suite ran; screenshot shown to Daniel.
- Not tried: a real rough line. The policy's marks (3 percent, 50 ms) come from what ticket 28 measured on clean lines
  (about 0.2 percent, under 10 ms) and from what is plainly audible; the first `voice_quality` rows from a stuttering
  friend will say whether they sit right. RED on a real phone browser: Chrome on Android lists it; Safari untested.
