# 28 · A longer voice buffer in low bandwidth mode

Status: shipped 2026-09-27 to nightly and prod (1816f49)
Asked for 2026-09-27: with low bandwidth voice (ticket 27) the friend on the bad line is "a bit better" to understand
"but still very jitterish". Options weighed: RED (a repeat of the previous frame in every packet, against lost packets),
a longer buffer (against packets arriving in bursts), longer packets (already 60 ms; longer only makes each loss a bigger
hole). No problem report from that call, and the friend's browser sends no events, so loss and jitter could not be told
apart. Decided with Daniel: the buffer first, being the smallest change and costing no data; RED if a report taken while
he is choppy still shows lost packets.

## Built
- `core/lowvoice.ts`: `LOW_VOICE_BUFFER_MS` 200.
- `client/call.ts`: `applyVoiceBuffer` sets `jitterBufferTarget` on the voice receiver while low bandwidth voice holds
  between us, that is while it is on here or the friend's last description asked for it (`asksLowVoice`), and clears it
  otherwise. Applied when their voice track arrives, after each remote description, and when the setting is switched.
  Problem reports carry `voiceBufferMs` per peer beside the jitter buffer stats from ticket 27; the dev hook too.
- The setting's hover text, spec §6.1 and `CONTEXT.md` mention the buffer.

## Verify
- `pnpm typecheck`, `pnpm test`.
- `E2E_FIREFOX=1 pnpm e2e`: the low bandwidth voice test now also checks that both sides ask for 200 ms and report a
  target of at least 150 ms once Alice alone switches it on, and none after she switches it off.
- Measured: Chromium buffered its friend's voice about 60 ms before and about 190 ms after, on both sides. Firefox about
  35 ms before and about 100 ms after, steady over 30 s, although it reports a target of 200 ms.
- Not tried: the real line. Next call with that friend, a problem report from Daniel's side while he is choppy tells
  whether packets are still lost (`packetsLost`, `concealedSamples`); if so, RED next.
