# 69 · Flake: after low bandwidth voice is switched off, a 200 ms voice buffer is still asked

Status: fixed in the test, cause proven from the wire log
Type: flake

Seen "expect(received).toBeNull(), Received: 200" at `settings.spec.ts:271` ("low bandwidth voice caps the voice both
ways from one side…"), Chromium on the dev box, master 3479324; CI passed the same code:
- 2026-10-28, a full run (2 workers, no retries): the `local` row in the flake ledger.
- 2026-10-29, 1 of 12 repeats of the test alone with 4 workers (a hunt, not in the ledger).

## Cause
Not the low voice floor. Bob's wire log at the first failure: Alice `asksLowVoice: false`, `voiceBufferMs: 200`,
`adaptiveMs: 200`, last window `concealedPct: 3.9`. The repeat showed the same on both sides (3.7 and 4.6 %). The buffer
that follows the line (ticket 34, `nextBuffer` in `core/voicequality.ts`) raises the target on a rough window (3 %
concealment or 50 ms jitter, at least 40 packets, more than two windows after the last change), and its first step,
`BUFFER_STEPS_MS[0]`, is 200 ms, the same as `LOW_VOICE_BUFFER_MS`. It takes a clean minute to lower it again. The app
did as designed; the test claimed nothing would be asked at all.

The rough window came as the voice switched back from 60 ms to 20 ms packets, on a box running two or more tests at once.
Whether the switch itself conceals audibly on a quiet machine is not known; CI has not shown it.

## Fix
The test now says what it means: Alice's setting is off and Bob sees her no longer ask for low voice, and what each side
asks is exactly the adaptive buffer (`voiceBufferMs` equals `adaptiveMs`, both read in one hook call).

## Comments
