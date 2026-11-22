# 92 · A file announcement the Store could not keep is lost for friends away, while its pieces go again

Status: open; cause found from the wire logs (Workers Logs expired), not fixed
Type: flake, and a gap in the app

Seen 2026-11-17: the preview run of #157 at 6616e80 (run 44168521032, Firefox shard 3), passed on its retry:
`attachment.spec.ts` "ADR 0009: a picture sent while nobody else was there comes from the server, sealed, once its
sender is gone". The picture never showed in Bob's log within 30 s. First filed under ticket 81, whose cause is a
different one (a socket dropped under a `fetch`).

## What the wire logs say
From the failed try's `Alice-wire.json` and `Bob-wire.json`:
- Alice's `sync`, at her welcome, was answered `history` with `unavailable: true`. The Store's daily share was not out
  (Bob's `sync` 18 s later was answered normally), so the Room's call to the Store threw (`worker/room.ts`, "history not
  served").
- She sent the `file`, and the Room broadcast it back to her: it was accepted, and handed to `keep`.
- Her three pieces were answered `kept` with `ok: false, again: true`, which is the Store's call throwing ('failed'),
  all within the same second. Her app sent them again 15 s later, and all three were kept.
- Bob came in 18 s after the `file`. His `sync` was answered with no entries at all, not `unavailable`: the Store
  worked by then, and did not have the announcement. So his app never knew there was a picture.

The Room's `keep` (`worker/room.ts`) logs "history not kept" when the Store throws, and does not try again. That is as
designed ("the room goes on as before: friends online have it, and only those away miss it"). But a piece that fails
goes again, so the Store ends up with the file's pieces and no announcement pointing at them, and the sender's app is
never told: there is no answer to a `file` like `kept` is to a piece.

Not known: what the Store threw. Workers Logs of `dave-pr-157` no longer have 2026-11-17 (asked 2026-11-22: nothing).
On a preview, 16 shards share one Store, and its first calls in a run may be slow.

## Next
- Decide whether this is worth fixing for the live site too: a friend away misses a text or a file whenever the Store
  fails for a moment as the message is sent. If yes, the smallest change is a second try of the `keep` in the Room,
  on the same chain (`keeping`), so the order of keeps holds. Otherwise the test claims too much for a preview, and
  should wait for something that says the announcement is kept (nothing does today).
- The next sighting: read the preview's Workers Logs the same day for "history not kept" and "piece not kept".
