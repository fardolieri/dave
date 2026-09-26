# 29 · No fingerprint beside names

Status: built 2026-09-27, on nightly
Asked for 2026-09-27 by Daniel: the fingerprint beside a name (for a key not yet acknowledged, and when two keys show
the same name, issue #7) is just annoying. Friends switch between phone and PC a lot, each device its own identity
under the same name, so the duplicate-name case fired all the time. Anyone who cares opens the profile card.

## Built
- `client/App.tsx`: presence rows, call rows and chat lines show the name and the "new" badge only. The fingerprint
  stays in the hover title and the profile card. The "someone else here is also called X" warning is gone for the same
  reason.
- `core/names.ts`: `ambiguousNames` and `showsFingerprint` removed with their tests; the `.fp` styles too.
- README, `CONTEXT.md` and spec §3 and §6 updated.

## Verify
- `pnpm typecheck`, `pnpm test`.
