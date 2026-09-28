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
