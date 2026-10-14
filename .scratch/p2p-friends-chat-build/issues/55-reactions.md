# 55 · Reactions: emoji that float up over the call

Status: on a branch (`feature/reactions`), not on master
Asked for 2026-10-10: Daniel: "surprise me with a cool new PR. Think about what feature i would enjoy". Nobody asked for
reactions as such; this is the agent's pick, open to a no.

## Why this one
Friends in a call watch each other's screens: a game, a video, a bug. Laughing into the microphone talks over the share's
sound and the person talking, and a text gets read later. A tap that floats 🔥 across everyone's screen says it right then.
It also fits what dave already is: emoji as profile pictures, an emoji picker, each friend's own sound.

## Built
- `core/protocol.ts`: `react` both ways. Up: one emoji, by the profile picture's rule (`normalisePicture`). Down: the
  sender's public key and the emoji; name and picture come from presence.
- `core/room.ts`, `core/ratelimit.ts`: participants only; broadcast to every socket in the room, visitors too, so a friend
  reading along sees the mood of the call. A bucket of its own, 10 a second, 20 at once, so hammering 🔥 never starves
  texts or mutes. Nothing is stored.
- `client/room.ts`: `reactions()` (on screen now, gone after 3.2 s, at most 40), `react(emoji)` held under the server's
  limit (6 a second, 12 at once), so it rarely gets a refusal (frames held up on the way can still arrive in a bunch);
  a refusal is not said in the chat. Best effort in the outbox's terms (`.scratch/quality/issues/10-reliable-delivery.md`):
  sent only on a socket in the call, never held or sent again.
- `core/cue.ts` `reactionCue`: one soft note per emoji from its hash, on the bright pentatonic scale from C5 to E6, so a
  flurry from several friends plays a little tune that never clashes. `client/attention.ts` plays it only in the call I am
  in, mine too, thinned to one every 60 ms; never during a mic test.
- `client/App.tsx`, `styles.css`: a row of six quick reactions and a + (the emoji picker, open for more) between Share
  screen and Leave; the floating layer over the room's side of the app (all of it on a phone), each reaction from a spot of
  its own, swaying, with the name under it; the emoji pops out beside the sender's avatar in the call list. The layer
  shows the room I read and, when my call is in another room, that call's too. A fullscreen share shows the reactions
  and keeps the quick ones in its bar, on a row of their own on a phone. Reduced motion: they fade in place.
- No stored state, so nothing to migrate. An old client ignores a `react` frame (it falls through every switch).

## Verified
- See the PR: unit tests (`test/core.test.ts`, `test/cue.test.ts`) and e2e `e2e/reactions.spec.ts`.
