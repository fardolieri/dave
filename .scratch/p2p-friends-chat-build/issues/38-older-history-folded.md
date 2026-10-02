# 38 · Texts from more than 18 h before the room came on screen start out folded

Status: done 2026-10-02, awaiting deploy
Asked for 2026-10-02: Daniel: "When opening a chat I want chat history that is older than 18 hours to be hidden by default."

## Scope
- When a room comes on screen (the page opens on it, or a switch to it), the texts from more than 18 h before that
  moment are folded away: the log starts with "Show older messages" above the first line shown, barely visible, no count.
- A click unfolds them; the reader stays where they were (the lines come in above). They stay unfolded while the room
  is on screen; the next time it comes on screen they are folded again.
- The cutoff is fixed at the opening: lines that age past 18 h while the room is up stay; live lines always show.
- Only a run from the start folds, so what shows is one piece of the conversation without holes. Nothing is deleted:
  the stored history (500 per room, ticket 09) is unchanged, and "Clear chat history" works as before.

## Built
- `core/chatlog.ts`: `FOLD_OLDER_MS` (18 h) and `olderCount(lines, cutoff)`, the leading run older than the cutoff; unit
  tested in `test/chatlog.test.ts`.
- `client/App.tsx`: `openedAt`, a memo of `Date.now()` on the room on screen. `ChatLog` takes it, shows
  `lines.slice(folded)`, and the `.chat-older` button records the opening it was clicked in (`unfoldedFor`), so a new
  opening folds again without an effect writing a signal. Grouping under one name (`continues`) runs on the lines shown,
  so the first line shown always carries its writer's name.
- `ChatLog`'s line effect tells a line added at the bottom from lines added above it (the newest line's id changed or
  not): only the first shows the "new messages ↓" pill to a reader scrolled up; the unfolded lines, and the history
  as it loads, keep the reader in place.
- `styles.css`: `.chat-older`, centred plain text, 11 px in the dim colour at 60 % opacity, no border or background; full
  opacity on hover or keyboard focus.

## Verify
- `pnpm typecheck`, `pnpm test`: 196 of 196, the two new ones included.
- `E2E_FIREFOX=1 pnpm e2e e2e/text.spec.ts`: 20 of 20, both engines. The new test ages Bob's stored history in
  IndexedDB (two texts 19 h old, one 17 h), reloads: "Show older messages", only the 17 h line with Alice's name; a live
  line shows; the click unfolds all four; switching rooms and back folds them again.
- Screenshots, phone 390×844 at DPR 3 and desktop 1280×800 at DPR 2, 30 lines of 26–23 h ago and two from this
  morning: the button sits right above the morning's lines; after the click the first morning line's top edge is at the
  same pixel (723 / 682), gap to the bottom 0, no pill.

## Changed the same day: quieter, and no count
Daniel, after the screenshots: "I want the button to be even less noticeable. And dont tell the user how many messages
are going to be revealed after click." The outlined pill is now plain dim text at 60 % opacity; the label is "Show older
messages" whatever the number, and the test checks that text. Screenshots again at DPR 3 (phone) and 2 (desktop).
