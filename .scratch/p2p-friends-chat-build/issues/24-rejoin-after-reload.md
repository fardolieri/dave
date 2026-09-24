# 24 · Rejoin after a reload

Status: shipped 2026-09-24 to nightly and prod (a485fb6)
Asked for 2026-09-24: "When in a call and clicking the refresh button in the browser I want to be automatically be
reconnected to the channel I've been in before." Then: "its fine if the own screen share dies in the process. but it
would be nice if watched streams would automatically continue".

Builds on the rules settled with Daniel on 2026-09-11 in the archived installable-app effort (branch
`archive/pwa-installable-app`, `.scratch/pwa/issues/05-forced-update-and-rejoin-rules.md`) and the research on branch
`research/rejoin-without-a-click`. One rule changed: watched shares are now restored. The chat line "Rejoined the call
after a reload." from those rules was left out, as ticket 19 took the reconnect lines out of the chat.

## Built
- `core/rejoin.ts`: the marker `{ room, at, watching }`, parsing and the 30 s window. Unit tests in `test/rejoin.test.ts`.
- `client/call.ts`: the marker is written on join, every 10 s, on watch changes and on `pagehide`, and removed on Leave
  (also when another tab takes over, which leaves the call). Read once at load; when the room's socket connects, the
  join runs without the click: microphone first, then the sound unlock, then the declared join. Watched sharers still
  sharing are put back into the watch intents before the connections are built.
- Fix found on the way (also affects ticket 22's rebuilds): a viewer re-sends its subscription when a connection to the
  sharer reaches connected. The first ask reached the sharer while they still held the old connection, which the fresh
  offer then closed along with the subscription, and the tile stayed at "Opening…".
- `rejoinAfterReconnect` is now `redeclareAfterReconnect`, so the code follows the glossary: that path is a server
  reconnect, not a Rejoin.
- Fallback: remote audio refused with `NotAllowedError`, or a context still suspended after a Rejoin, shows "Click to
  hear the call" in the call controls; the click replays every remote element and resumes the context.
- `sound.ts` `tryUnlockSound()`: the cue context unlocks after the microphone is live, so the own join cue plays on a
  Rejoin too.
- Spec §8.1a, `CONTEXT.md` term Rejoin.

## Verify
- `pnpm typecheck`, `pnpm test`.
- `DEFAULT_AUTOPLAY=1 REJOIN_CHECK=1 node scripts/drive.mjs --join http://localhost:5199 <secret> Alice Bob` against
  `pnpm dev --port 5199`, 2026-09-24, headless Chromium under its real autoplay policy: Alice watches Bob's share and
  reloads; within 5 s she is back in the call, the tile is live again (bytes growing, video not paused, frames
  counting), the AudioContext is running and no "Click to hear" button shows. Bob, the sharer, reloads: he is back in
  the call, his share is gone, Share screen is ready. Alice leaves: the marker is gone, and after a reload she is a
  visitor. Same result with `AUTOPLAY_BLOCK=Alice` (autoplay site setting on Block): the live capture still unlocks
  playback, so the fallback button was not exercised.
- Not tried: Firefox, a phone, the fallback button.
