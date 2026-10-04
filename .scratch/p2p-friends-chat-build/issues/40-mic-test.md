# 40 · A mic test: hear yourself as friends do

Status: shipped 2026-10-04 to nightly (deploy and nightly e2e green), not yet to prod
Asked for 2026-10-04: Daniel: "Users should be able to test their microphone settings. I want a button in the audio settings
card that [mutes] yourself for others, [mutes] others for you, [and plays] everything you say to your speaker […] You should be
able to change the settings while the test is running so that you immediately see the effect." After talking it through:
"Lets also add the 'record 5 seconds, play back'".

## Decisions from the talk
- Live loopback needs headphones: through speakers it feeds back, and echo cancellation fights it. The browser cannot tell
  headphones apart, so the panel says so, and the recording works on speakers (a phone, mostly).
- Mute cannot be reused: it disables the microphone's track, which would silence the test too. The senders get a disabled
  track instead, and the microphone keeps running.
- Friends see the existing `muted` flag, no protocol change; my mute state comes back afterwards.
- Forgetting a test running is the worst case (silent and deaf in the call), so it ends with the panel, the page hidden,
  Mute or Unmute, and leaving.
- What plays is the voice before Opus: low bandwidth voice and voice repair are not heard in the test. Not worth a local
  encode loop.
- Making the test possible before joining a call is left for a later ticket.

## Built
- `client/call.ts`: `micTest` (`live`, `recording`, `playing`) with `hearYourself`, `recordMicTest`, `playMicTest`,
  `stopMicTest`. `sentVoice` stays what friends would get; the new `wiredVoice` is what the senders carry, a disabled track
  during a test. A monitor copies `sentVoice` into the call's AudioContext and follows it when it changes, so the live test
  and the recording follow a microphone switch or noise removal starting or stopping. Peer gains are 0 during a test.
  `mute: true` goes out at the start unless already muted, `mute: false` at the end unless muted; a server reconnect
  declares the join muted while testing. PostHog `mic_test` at the end; problem reports carry `micTest`.
- `client/attention.ts`: no cue during a test.
- `client/App.tsx`: the Mic test row under Volume, three buttons, the lit one ends the test; Record fills up over the 5 s;
  a warning while a test runs. The panel's cleanup ends it.

## Verified
- e2e `ticket 40` (Chromium and Firefox, 4 repeats each): live, the senders carry silence, Bob sees Alice muted, Bob's gain
  is 0, the monitor plays the processed voice and then the microphone once noise removal is switched off mid-test, Carol
  joining plays no cue; stopping brings all of it back and Bob hears Alice. Record 5 s plays back by itself, about 5 s
  long with sound in it, and the call returns when it has played. Play again, then closing the panel ends it. Muted before
  the test, the test still plays the microphone; Unmute ends the test and unmutes.
- Firefox's fake microphone is a steady tone, which RNNoise removes completely, so there the processed voice's level is not
  checked, only that the monitor follows it.
- Not tried on a real phone or with real headphones yet.
