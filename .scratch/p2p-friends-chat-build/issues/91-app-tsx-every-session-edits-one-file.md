# 91 · `src/client/App.tsx` is the file every session reads and edits at once

Status: open; move 1 done (the report and About dialogs, `src/client/Dialogs.tsx`, PR #176): `App.tsx` is down to 2,826 lines
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

2026-11-20, move 1: `ReportDialog` and `VersionDialog` (the About dialog) with its usage meters, 329 lines, went to
`src/client/Dialogs.tsx`. Chosen first because nothing ties them to `Workspace` but `ReportDialog`'s `collect`: none of
the block's 18 top-level names is used elsewhere in `App.tsx`, and it needs nothing that stays there. How the next moves
go, so each reads the same:

- Before starting, and again before the first push: `gh pr list`, then `gh pr diff <n> --name-only` for each open PR.
  One that touches `App.tsx` means wait.
- Find a group whose helpers nothing else uses: `grep -nw <name> src/client/App.tsx` for each top-level name in the
  block. Take whole lines, one contiguous range where the file allows, with the comments above each component.
- The new file sits beside `App.tsx`, named for its feature in the components' case (`Dialogs.tsx`, like
  `EmojiPicker.tsx`). Its imports come first; then the lines as they were. Only what `App.tsx` renders gets `export`;
  the helpers stay private. No rename, no reorder, no fix on the way, however tempting: a pure move is one the gate
  proves.
- `App.tsx` drops the imports it no longer uses. `npx tsc --noEmit -p . --noUnusedLocals` names them (its two in
  `room.ts` are older and not this ticket's).
- Prove the move byte for byte, both sides, and put both commands in the PR. What moved, which prints nothing:
  `git show origin/master:src/client/App.tsx | sed -n <from>,<to>p | diff - <(tail -n +<first line after the imports> src/client/<New>.tsx | sed 's/^export function/function/')`.
  What stayed, which prints only import lines (`<to>` here takes the blank line after the block too):
  `diff <(git show origin/master:src/client/App.tsx | sed '<from>,<to>d') src/client/App.tsx`.
  The first alone would miss a line lost just outside the range, which neither the typecheck nor `--noUnusedLocals`
  would catch.
- Grep the repo for each moved name: a comment that says where it lives (`styles.css` had "client/App.tsx,
  UsageMeter") is changed to the new file in the same PR.
- A group that needs something staying in `App.tsx`: a type comes over with `import type` from `./App` (erased, so no
  cycle at run time); a value both sides use moves out with the group, or to a small module of its own, never imported
  back from `./App`.
- `pnpm typecheck`, `pnpm test`, a review of the diff against this list, then the gate (rung 3).
