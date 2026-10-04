# 39 · A cue when someone starts sharing their screen

Status: shipped 2026-10-04 to nightly and prod, pushed straight to prod at Daniel's word, nightly e2e not waited for
Asked for 2026-10-04: Daniel: "I want an audio cue when someone starts a screenshare. give me some examples to chose from"

Seven candidates on a throwaway audition page with the app's own chime synth: five the same for everyone (an arpeggio
up to C6, a doorbell, an upward glide, a held shimmer dyad, two taps and up) and two from the sharer's emoji. Daniel
picked "their cue + sparkle".

## Built
- `core/cue.ts` `shareCue`: the sharer's join cue, its last note held to at least 90 ms, then a C6 over two steps. C6
  sits above every join cue (they stop at C5), so the end says "a share", the start says who.
- `core/attention.ts` `sharesStarted`: a share start is someone already in the call whose `sharing` flag turns on. A
  friend back from a server reconnect returns with the flag still set and is not counted.
- `client/attention.ts`: plays it for others' shares in every room this browser is in, like join and leave, and for my
  own share once the browser's picker has handed over the screen, so I know what the others hear.
- Stopping a share plays nothing (not asked for).

## Verified
- Unit tests for `shareCue` and `sharesStarted`; e2e `ticket 39` (Chromium locally, 3 repeats): the viewer hears the
  sharer's join tune then `sine 1047`, and the sharer hears their own.
