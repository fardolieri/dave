# 02 · Saved-state guard: a changed default or stored shape cannot slip through unnoticed

Status: shipped 2026-10-08 to master (d1d42a9, PR #27)
Type: task

## Why
Three times a change to what browsers store did not reach friends: new share defaults (20 Mbps, 60 fps) only applied to
fresh browsers; volumes saved before the share-volume fix stayed muted; Leave room left history behind. Each time it was
found by luck or by review, after the change was written.

## What
- One registry of everything this app keeps in a browser: every `local` key (`src/client/storage.ts`, `persisted(...)` in
  `call.ts`, and any other caller), every IndexedDB key, with its parser and its defaults.
- A unit test that snapshots, per key: the default value and the shape the parser accepts (field names and types). Changing
  a default or a shape makes the test fail with a message that says what to do: add a migration (and a test feeding the old
  stored value through it), or update the snapshot with a line in the commit saying who will not see the change.
- A test per key that an old stored value (a fixture copied from today's format) still parses to something sensible. This
  guards against crashes on old data, which is worse than a missed default.
- A short section in `CLAUDE.md` or the README pointing at the registry.

## Not
No migration of past changes the owner already decided against (old volumes: "Nah lets leave that", 2026-10-05).

## Built
src/core/storedstate.ts lists every stored key with its parser and dated old-value samples; every read goes through the registry (local.read, idbRead), so a new key fails typecheck until listed. test/storedstate.test.ts snapshots defaults and shapes and fails with what to do; old samples must still parse. The address book now repairs malformed entries instead of keeping them raw.
