# 18 · Three quick fixes from the problem reports of Sep 16 and 17

Status: resolved
Triage of the `bug_report` events in PostHog on 2026-09-19 (twelve reports since Sep 8, none from the driver after ticket 15). Three had a small, certain cause; the rest are listed under Open.

## Fixed
- **Reconnect lines flood the chat** (Sep 16, connection, annoying: ten "Reconnected after about 2 s offline" lines in one morning). PostHog over 30 days: 181 reconnects across 8 friends, median gap 1.5 s, 143 of 181 under 5 s; nearly all socket closes are code 1006 with the socket noticed dead at once, so the gap is only the backoff and the handshake. `room.ts`: the line is written from a 10 s gap on (`NOTE_GAP_MS`); the `server_reconnected` event still carries every gap.
- **Badges run over the name** (Sep 17, other, annoying: "when a friend is streaming and has manual volume settings the labels overflow"). The participant row was a wrapping flex row: the badges either jumped under the avatar as a block or, kept on the line, squeezed the name column to nothing and painted over it (reproduced headless with a long name, "sharing", a connection badge and a set volume). `styles.css`: the row is a grid, avatar / name floored at 8ch / badges, the badges wrap inside their column, the slider row spans all columns.
- **Emoji picker flickers on its first open** (Sep 16, other, annoying: once for the composer's picker, once for the profile picture's). The UA paints a popover at its own centred position before `toggle` fires, and `place()` runs in `toggle`; later opens keep the previous `left`/`top`, so only the first open of each picker jumped. `EmojiPicker.tsx`: `visibility: hidden` from `beforetoggle` until placed.

## Verify
- `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Headless (scratch scripts, not committed): two Chromium profiles in a call, one sharing, the other setting its volume; the row with `muted`, `sharing`, `via relay` and `🔊 150%` stays inside the sidebar (right edge 245 of 260) at 39 px height; the open slider row spans the full width at 260 px and 390 px; the picker opens above its button at the button's left edge.

## Open (not quick)
- **Audio after a rejoin** (Sep 17: "a friend rejoined and the volume was all over the place"; Sep 19: "they say I sound tinny when I re-join"). Both after the Sep 17 deploy; both from the listener's side about a friend who rejoined. Hypotheses: a second audio path surviving the rejoin (comb filtering would sound tinny and the level would swing), or the gain node rebuilt without the remembered volume. Needs a reproduction with two profiles and a leave/join.
- **Not heard on Android** (Sep 16, audio, blocking: friend heard others, others did not hear them; the speaking ring showed; speaker settings helped once). The reporter was not in the call when filing, so the snapshot has no peers. Needs the friend's own report or a recording.
- **Black share on Brave** (Sep 10) shipped in 51c0344; the Sep 9 black share was the reporter's own desktop portal. "One user exists twice" (Sep 10) shipped in e1db898.
- **Frequent 1006 closes**: 296 in 30 days from 8 friends, one Brave profile alone 81. The reconnect heals in a second or two, so friends barely notice now, but the cause (client sleep, network path, or the Durable Object) is not known.
