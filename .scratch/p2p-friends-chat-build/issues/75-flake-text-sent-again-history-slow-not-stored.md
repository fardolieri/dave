# 75 · Flake: a text sent again while the history is still being read was not stored within 20 s

Status: open, cause not found
Type: flake

Seen 2026-11-05: the preview run of #126 at 807c058 (run 42079021936), Firefox, shard 7, passed on its retry.
`text.spec.ts` "regression: a text sent again while my history is still being read after a reload counts once and
shows once": `expect.poll(() => alice.storedTexts(), { timeout: 20_000 }).toContain('after')` saw `["on my way"]`.

## What the trace says
- Alice reloads with every IndexedDB `get` of a `history:` key held back 6 s (the test's own init script).
- About 6.2 s after the reload, her page has the frame of Bob's `after` (three `sealed` frames down within 6 ms).
- 16 s later the poll gives up, with `after` still not in IndexedDB. `storedTexts` reads with `getAll`, which the test
  does not slow.
- Every `sync` of both friends in that run was answered `history … unavailable`: the preview's daily share of syncs was
  used up that evening (ADR 0009: the shares were raised the next day). Other history tests of that run failed outright.

## Suspects, not proven
- `appendTo` (client/history.ts) writes every room's history on one chain, each write reading its key first (6 s here).
  Writes queued ahead of `after`'s would each add 6 s. Which ones those were at 807c058 is not known.
- `received` waits for `historyLoaded` before the write. A slower read of the history than the 6 s would push it out.

The same test passed in both engines on #126's head at cde8220 and later. Next: run it locally with the chain's
entries logged (key, queued at, read done), and see what stands ahead of `after`.
