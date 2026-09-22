# 21 · Master volume in the audio settings

Status: resolved
Asked for 2026-09-22: "add a master volume kind of slider to the audio settings that regulates the speaker volume
of all participants". Ticket 08 gave every other participant a local volume of their own; this one sits above them
all, for the moment the whole call is too loud or too quiet for you.

## Built
- `core/settings.ts`: `AudioSettings.masterVolume`, 0 to `MAX_VOLUME` (200 percent), default 1, stored with the
  other audio settings and validated on parse (out-of-range or ill-typed values fall back to 100 percent, older
  blobs without the field read as 100 percent).
- `client/call.ts`: every participant's two gain nodes (voice, share audio) are set to master times that friend's
  own local volume. `changeAudio({ masterVolume })` re-applies all peers live; new connections start at the product.
  Nothing is signalled; nobody else is affected.
- `client/App.tsx` `AudioPanel`: a "Volume" slider (0 to 200, step 5, double-click resets to 100) with the
  percentage beside it, between the speaker picker and the processing toggles.
- Solid 2 finding, fixed on the way: a signal written in the current run still reads its old value in that run, so
  `changeAudioNow` could not re-read `audioSettings()` after storing. The gain applier and `microphoneConstraints`
  now take the freshly written settings as an argument; before, a microphone switch re-captured under the old id.

## Verify
- `pnpm typecheck`, `pnpm test` (120), `pnpm build`.
- `VOLUME_CHECK=1 node scripts/drive.mjs --join http://localhost:5199 <secret> Alice Bob` against `pnpm dev --port 5199`,
  2026-09-22: Bob's slider to 150 sets both gains to 1.5; the master slider to 50 sets both to 0.75 with the panel
  reading "Volume 50%"; after a reload and rejoin master is 0.5 and the gains come up at 0.75 again.
