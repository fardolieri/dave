# 91 · `src/client/App.tsx` is the file every session reads and edits at once

Status: open; not started
Type: task (from the retrospective of 2026-11-19 over the week's 45 agent sessions)

`src/client/App.tsx` holds 71 components in 3,147 lines: `Workspace` alone is 741, `Composer` 260, `ChatLog` 187,
`ShareTile` 184, `FileView` 157. Every feature of the chat lands in it.

What that cost in the week to 2026-11-19 (read from the session logs):

- It was read or searched 307 times, twice as often as the next file (`e2e/party.spec.ts`, 205; `src/client/room.ts`,
  158), in pieces of up to 28 KB (`sed -n 2700,3110p`): an agent cannot hold it, so it reads it by line ranges and
  reads again after every rebase.
- 3 of the week's 4 rebase conflicts were in it (the YouTube title link, the `/yt` roll, the `/gif` roll): two sessions
  at work at the same time nearly always both touch it.

## What to do

Move components out into files of their own beside it, by feature, with no change in behaviour: the composer (with its
staged files, YouTube card and rolls), the chat log and its lines, the file and picture views with the viewer, the
share and party tiles, the dialogs (version, report, profile, themes). `Workspace` keeps what ties them together.

- One move per PR, each a pure move the gate proves (rung 3): no rewrite on the way.
- Start a move only while no other open PR touches `App.tsx` (`gh pr list`, then `gh pr diff <n> --name-only`): a move
  under someone's feature is the conflict this ticket is about.
- Done when no file in `src/client/` is over 1,000 lines but `call.ts` and `room.ts`, which are their own tickets if
  they turn out to cost the same.

## Comments
