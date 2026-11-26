# 96 · How long a friend's voice takes to reach the ear

Status: measuring
Type: research

Daniel, 2026-11-26: a game's own voice chat was roughly 300 ms faster than dave's in the same session. How high is
dave's delay, and where does it go?

## What the field said before this ticket (live, `voice_quality`, 30 days to 2026-11-26, about 57,000 windows)

| Leg | Median | p90 |
|---|---|---|
| Network, one way (half of `rtt_ms`) | ~18 ms | ~27 ms |
| Jitter buffer held (`buffer_ms`) | 45 ms | ~100 ms |

Relayed links: 47 ms round trip at the median, direct 29 ms. iPhones (80 windows): 135 ms of buffer at the median. The
buffer that follows the line (ticket 34) sat at 200 or 400 ms in 3 % of windows; 90 % of its raises came from
concealment, not jitter. So the network and the jitter buffer explain about 65 ms, not 300 ms more than a game's chat.

## The path, and what each leg reports since this ticket

Speaking friend:
1. Microphone to page: `voice_send.mic_ms` (Chromium's `MediaStreamTrack.stats.averageLatency` on the microphone, over
   the event's window). New.
2. Noise removal: `voice_send.path`. On `frames` (Chromium) a frame waits under 10 ms for RNNoise's 10 ms frame. On
   `context` an AudioContext of its own sits in between: its input and output buffers, and one frame of silence first
   (`voice.worklet.ts`). Not measured.
3. Opus: 20 ms packets plus the encoder's look-ahead. Fixed, not measured.

Listening friend:
4. Network: `voice_quality.rtt_ms` / 2.
5. Jitter buffer: `voice_quality.buffer_ms`.
6. The browser's output for call audio: `voice_quality.playout_ms` (`media-playout`: the output device's own delay as
   the browser reports it). New. dave keeps that output muted (the `keepAlive` element, needed before Chrome feeds remote
   audio to WebAudio) and plays the voice another way. It is the default output device: for a friend who picked a
   speaker in the Audio panel (`voice_quality.speaker` = `chosen`, say a Bluetooth headset) it says nothing about the
   one they hear, so leave those out of the sum:
7. The call's AudioContext (`wireRemoteAudio`): the voice goes in through a MediaStreamAudioSourceNode, per-friend gain,
   out through a MediaStreamAudioDestinationNode. `voice_quality.context_base_ms` (its processing buffer) and
   `context_output_ms` (its own output on the default device, which nothing plays through); left out while the context
   is not running. New.
8. An `<audio>` element plays that destination (for `setSinkId`): in Chromium a second output stream of its own, with
   its own buffer. **No API reports it.** This is the leg the game's chat does not have, and the prime suspect.

A lab run of two local Chromium pages (fake devices, so the values mean nothing for real devices) showed every new
field filled: `playout_ms` 30, `context_base_ms` 10, `context_output_ms` 32, `mic_ms` 7 to 9.

## Reading it

```sql
select properties.$os, count(),
  quantile(0.5)(toFloat(properties.buffer_ms)), quantile(0.5)(toFloat(properties.rtt_ms)) / 2,
  quantile(0.5)(toFloat(properties.playout_ms)), quantile(0.9)(toFloat(properties.playout_ms)),
  quantile(0.5)(toFloat(properties.context_base_ms)), quantile(0.5)(toFloat(properties.context_output_ms))
from events where event = 'voice_quality' and properties.playout_ms is not null and properties.speaker = 'default'
  and coalesce(properties.build_target, 'live') = 'live' group by 1
```

and `voice_send` for `mic_ms` by `path`. Their sum, with about 30 ms for Opus and noise removal, is the delay up to leg
8. Leg 8 stays unknown in the field: the ear is the only measure of it (two devices side by side in one call, a clap
recorded by a third: the distance between the clap and its echo out of the other device).

## Next

If the measured legs leave most of 300 ms unexplained, leg 8 is it: play friends' voices from the call's context
straight to `ctx.destination` (choosing the speaker with `AudioContext.setSinkId`, Chrome 110+), which drops the second
output stream and makes the rest measurable (`outputLatency`). That path is the one #201 rewrites for Android's
silent voices: build on it, not beside it.
