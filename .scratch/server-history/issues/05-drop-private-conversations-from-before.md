# 05 · Drop the private conversations from before rooms of two

Status: waiting: not before four weeks after the deploy that brought #126 (if it lands on 2026-11-10: 2026-12-08)
Blocked by: 03

**Why:** since rooms of two (ADR 0011), a private conversation from before them is read from this browser's history
under `private:<friendKey>`, which nothing writes to any more, and shown above the room of two's texts
(`client/privates.ts`, `loadArchive`). It was never moved into the room of two (owner, 2026-11-10): a move could only run
once the room of two exists, which needs the friend's key seen again, and the four-week window already applies to it.
Reads leave out what is older than the window (`client/history.ts`, `read`), so four weeks after the deploy every such
conversation reads as empty in every browser. Then the code that reads it, and the keys themselves, can go.

**Then:**
- Delete the `private:<friendKey>` keys once, as the app starts: they read empty, but keep their old entries in IndexedDB
  until then, because nothing writes them (and count against the browser's share until read).
- Drop the archive from `client/privates.ts` (`archives`, `loadArchive`, `archivedId`) and from `client/history.ts`
  (`loadPrivate`, `appendPrivate`, `HistoryKey`'s `private:`), and its entry in `core/storedstate.ts`, with a fixture
  test that the old key is deleted.
- `unsentPrivate` (localStorage): texts that waited from before rooms of two. A day after the deploy none can go any more
  (`core/unsent.ts`, `tooOld`), so `adoptUnsent` and the key can go in the same change.
- Check whether `unreadPrivate` is still read anywhere (`client/unread.ts`); it is not carried over (ADR 0011).
- `privateThreads` stays: it is the list of conversations, rooms of two included.

**Done when:** a browser with the fixtures of `private:<friendKey>` and `unsentPrivate` opens with them deleted, its
conversations show only the rooms of two's texts, and `test/storedstate.test.ts` lists neither key.
