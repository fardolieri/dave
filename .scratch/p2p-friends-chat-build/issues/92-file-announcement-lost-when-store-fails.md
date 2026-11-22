# 92 · A file announcement the Store could not keep is lost for friends away, while its pieces go again

Status: fixed 2026-11-22 in the Room (a keep the Store threw on is tried again); done once its ledger row stops growing
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

## Comments

2026-11-22, fixed: the Room's `keep` (`worker/room.ts`) asks the Store again 1 s, 4 s and 15 s after a keep it threw on
(`KEEP_RETRY_MS`), the last try 20 s after the first, with a stub of its own each try, on the same chain (`keeping`): later keeps wait, so the order of
keeps holds, and a sync waits for the tries as it waits for any keep under way. The Store keeps an entry once per
writer and id, so a keep that got through though its call threw is no second entry. The logs say "history not kept,
keep failed, trying again" for each try again (so a search for "history not kept" finds only the lost), and "history kept on a try again" or "history not kept" (with `tries`) at the end.

Regression test: `test/kept.test.ts` "a file announcement the Store failed to keep is kept on another try, so a friend
away still learns of it (ticket 92)": the Room's next keep throws, and Bob's sync must still bring the announcement.
It fails on the Room from before (Bob's history empty).

Why 20 s: the sighting does not say when the Store came back, only that it kept the pieces sent again 15 s after it failed
them, and answered Bob's sync 18 s after the file. The tries cover that. While they go on, syncs and forgets in that room
wait for them, as they wait for any keep: only while the Store fails, when they would fail too.

What it does not cover: a Store that fails for longer than 20 s. Then the announcement is lost as before, and the sender's
app is still not told; that would need an answer to a `file` as a piece has `kept`. Not done: nothing has shown one.
The tries also go to errors Cloudflare marks `overloaded`, which its docs say not to retry: at most three more calls per
keep, over 20 s, to one Store.
