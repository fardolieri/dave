# 27 · Low bandwidth voice and the round trip beside each name

Status: on master 2026-09-26 (not pushed, so not on nightly or prod yet)
Asked for 2026-09-26: a friend's internet is so bad "we can barely understand what he is saying", and then "is there
at least something we can do to reduce the latency? Currently it's like 10 seconds". The bug report of 21:21 UTC
(category audio) could not show it: problem reports carried video stats only. Ten seconds is no jitter buffer; packets
queue on the line, either because it is thinner than the call (throttled mobile data: 32 or 64 kbps against about
55 kbps per voice stream, most of it per-packet overhead at 20 ms) or because other traffic fills it (bufferbloat).
Decided with Daniel: build both, a low bandwidth setting and the delay shown per friend.

## Built
- `core/lowvoice.ts`: `lowVoiceSdp` rewrites the voice section (first `m=audio`, SLOT_INDEX order) to Opus
  `maxaveragebitrate=12000;maxplaybackrate=16000;usedtx=1` and `a=ptime:60`, replacing ptime and maxptime lines,
  idempotent, fingerprints untouched. `asksLowVoice` tells a description that asks for it. `lagLevel`, `formatDelay`.
- `client/call.ts`: with the setting on, the description sent is rewritten (the other side's encoder obeys it) and so is
  the remote description before `setRemoteDescription` (my encoder obeys it). No local-description munging, so nothing
  depends on Chrome still allowing it. Toggling mid-call offers again on every connection (`renegotiateVoice`, waits out
  a negotiation under way). PostHog: `low_bandwidth_voice_toggled`.
- Round trip: `PeerView.rttMs`, from the 2 s stats read, the larger of the selected pair's `currentRoundTripTime` and
  RTCP's `remote-inbound-rtp` `roundTripTime`. Shown beside the connection badge: grey, amber from 400 ms, red from 1 s;
  the hover explains and points at the setting.
- Problem reports: `inboundVoice` (loss, jitter, jitter buffer, concealment, FEC, codec), `outboundVoice` (bytes,
  packets, target bitrate, the remote side's loss and round trip), the pair's round trip and available outgoing
  bitrate, `asksLowVoice` per peer, `lowBandwidthVoice`. Flat fields `max_rtt_ms`, `low_bandwidth_voice`,
  `peers_asking_low_voice`.
- `settings.ts`: `lowBandwidthVoice` (default off). Audio panel: "Low bandwidth voice" toggle. Spec §6.1; `CONTEXT.md`:
  Low bandwidth voice, Round trip.

## Verify
- `pnpm typecheck`, `pnpm test` (lowvoice and report tests).
- `E2E_FIREFOX=1 pnpm e2e`: new test "low bandwidth voice caps the voice both ways from one side…": Alice alone switches
  it on, and both Alice's and Bob's voice encoders drop from 50 to under 20 packets per second at 14 kbps or less; it
  survives a reload and switches back. Checked by packets and bytes, not by codec stats: Firefox's codec stats show its
  own fmtp, not the one it obeys.
- Measured with noise removal off (no DTX gaps): Chromium 50 → 16.7 packets/s, target bitrate 32 → 12 kbps; Firefox
  50 → about 17.5 packets/s, 65 → 12 kbps payload. Both directions, from one side.
- Not tried: a real throttled or bufferbloated line. The next call with that friend: read the round trip beside his
  name, switch the setting on (either side), and send a problem report so the voice stats show loss and delay.
