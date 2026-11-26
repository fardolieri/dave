# 95 · Flake: a friend back from a gap is not reconnected in time, three games drawing in software

Status: open
Type: flake

Seen 2026-11-26, the gate of #202 at bc6b207 (run 45902757852, Chromium shard 6, against the preview), first try only:
`game.spec.ts:190` "a friend back from a gap, moved over to the game of a kind started since…" failed at line 226,
`carol.connected()` after `carol.wire.restore()`: the "Connecting / Reconnecting / Server unavailable" banner was still
up after 20 s. The ledger also has the same test on 2026-11-22 (run 45042668616), later on: "Carol links up with both".

#202 (Bonk ties, wind, the first round counted again when who is here changes) touches neither the room's socket nor
its reconnect; the step that failed comes before any game step of Carol's.

Cause to find: three pages draw Bonk in software on a runner while Carol's socket is cut and restored. Whether the
reconnect waits out a backoff longer than 20 s once her page is busy (`src/client/room.ts`), or the page is too busy to
take the welcome, is not known. Her socket's frames in the test's wire log (`Carol-wire.json`, in the run's artifacts)
would tell when it came back.

## Comments
