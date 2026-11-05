---
status: accepted
date: 2026-11-04
---

# One Store keeps every room's sealed texts, in one window of 4 GB, and browsers sync from it

Friends want chat that persists and syncs: a friend who was away, or opens a room on a new device, should see what was
said meanwhile. Until now a text reached only the friends online when it was sent, and each browser kept its own copy
(ticket 09). The server becomes an always-on peer that keeps what it relays and hands it to whoever missed it. It keeps
only what it already relays sealed (ADR 0005, 0006): it cannot read it, and search, if any, stays in the browser (owner,
2026-11-03).

A new Durable Object class, **Store**, of which there is one (`idFromName('history')`), keeps every text and file
announcement a Room broadcasts, as it broadcast it: `{ t, from, sealed, at, id }`, in SQLite, by room id. The Room hands
each one over after its broadcast (`keep`, `waitUntil`); a failure there is logged and changes nothing for friends online.
After every welcome a browser sends `{ t: 'sync', since }`, and the Room answers with the newest 500 the Store kept after
it, in `history` frames of about 256 KB, the last saying up to when (`upTo`, the Room's clock), or that it could not say
(`unavailable`). `since` is where the browser last had everything of the room (`historySynced` in localStorage) less
five minutes: moved on by an answer shown in full, and by texts that came live on a socket whose answer was, never by a
live text alone, which would skip what an answer lost on the way still had to bring. The browser opens a frame's entries
all first, then shows, keeps and counts them in one go, or none of them should the room have left the tab or its history
been cleared meanwhile; it drops those it has (by writer and id) and puts the rest where their time says.

The window is one for all rooms: past 4 GB the entries kept longest go, whichever room they are of (owner, 2026-11-03:
"a rolling window of all data combined"). 4 GB is 80 % of the 5 GB of Durable Object storage the Workers Free plan gives
the account (developers.cloudflare.com/durable-objects/platform/pricing, read 2026-11-03), which fails writes past it
rather than billing; the rest is for the Rooms and the previews, which count against the same 5 GB. An entry counts as its
JSON plus 512 bytes, its row and indexes as measured in workerd, so 4 GB counted is a little more than 4 GB on disk. The
About dialog shows how full it is and how far back it reaches (`/history-usage`).

## Details

- What the server keeps beside the sealed bytes: the writer's key and fingerprint, their profile as it was then, sealed
  (ADR 0010, the name and picture only friends can read), the time, the id, the room id, and how big each is. It saw all
  of it before, in passing; now it keeps it. A device that never met the writer opens the name from the entry's tag.
- One object for all rooms rather than the history in each Room: a single window needs a single place that knows which
  entry is oldest; in each Room it would take a ledger and messages between them. A test on 2026-11-04 wrote 4.5 GB into
  one SQLite object on this account without an error, though the FAQ says 1 GB per object on the Free plan. One object
  serves every room's keeps and syncs, one at a time: plenty for a group of friends, and the first thing to split should
  that change.
- The free plan counts rows, the account's: 100,000 written and 5 million read a day, which the Rooms need too (a room's
  verifier is read on every challenge). So the history takes a share and no more, whoever asks: 70,000 rows written a
  day, counted as SQLite counts them, what a keep drops from the tail included; 10,000 syncs (one row each); 2 million
  rows read. Past a share, until 00:00 UTC, texts go out live but are not kept, syncs are answered `unavailable`, and
  files are neither kept nor given. A socket may ask for a sync once per 10 s.
- Once the window is full, each byte kept drops an older one. A piece dropping texts writes about three rows per text,
  one dropping pieces three per 256 KB: with files most of the bytes, as they will be, the day's share of writes keeps
  hundreds of MB of files a day; a window full of texts alone, some 20 MB.
- The tail of the window is cut at every keep, by as much as that keep went past it and no more: the totals row that
  says how full the window is is read and written by every keep anyway, so the check costs nothing. Cutting 200 MB at
  once when full would not write less (every entry is deleted once, whenever), only all at once: 200 MB of texts is
  some 200,000 rows, past the day's writes in one go (owner's question, 2026-11-05).
- Files up to 16 MB (`KEPT_FILE_MAX`) are kept too, in the same window (owner, 2026-11-05). The sender's app sends each
  in pieces of 256 KB, sealed with the room's text key and bound to the room, the file's hash and the piece's place
  (`src/core/sealed.ts`, `sealPiece`), as `{ t: 'piece' }` frames paced under a rate of their own, after the
  announcement; the server answers each with whether it keeps it (`kept`), and the app sends what it did not keep
  again, a few times at most. The Store keeps each piece as an entry of its own (writer none, id `<hash>:<n>`), so pieces
  and texts share one order and one tail; a sync brings no pieces. A friend's app still pulls a file from a friend online
  first; the server is the last it asks in a round, when no friend gave it (none online, or none reachable), piece by
  piece (`{ t: 'fetch' }`), and the whole file is checked against the hash its announcement signed before it shows. Larger files go friend to friend only: one 700 MB
  video would push weeks of every room's texts out of the window. A file whose oldest pieces the tail took is not
  given: what is left of it waits there to go too.
- A text sent again after a lost socket is broadcast again under its id (ticket 51); the Store keeps it once (room,
  writer, id). Browsers drop doubles anyway.
- Clearing a room's history in a browser records when (`historyCleared` in localStorage), and its syncs ask from then on,
  so the cleared texts stay cleared there. Leaving a room forgets that too: the link brings the room back with what the
  server keeps of it.
- What a sync brings into a browser that held nothing of the room (a new device, a room rejoined) is not counted unread;
  what it brings into one that held some is, without a chime: a batch arrives at once.
- Private conversations are rooms of two (ADR 0011), and keep their texts and files like any room.

## Consequences

- The Workers Free plan's 5 GB is now a limit the app relies on. Should Cloudflare enforce the FAQ's 1 GB per object,
  the Store's writes fail past it, the Room logs `history not kept`, and live chat goes on.
- The migration that adds the class (`v2` in wrangler.jsonc) is one that Cloudflare refuses to roll back past
  (`rollback.yml`): after this deploy, a bad deploy is fixed forward or rolled back to a version that has the Store.
- Previews have a Store of their own, which starts empty and goes with the preview.

## Considered options

- The history in each Room, with a window per room or a ledger for one window: the first is not what the owner asked
  for, the second is the same Store with more messages.
- R2 for the bytes: 10 GB free, but it bills past that with no cap, and the bytes are a later ticket anyway.
- Workers Paid ($5 a month): 10 GB per object, storage past 5 GB billed instead of refused. One setting away if 4 GB is
  too little; nothing in this design changes.
- A browser keeps a sync position (the Store's sequence number) instead of asking by time: exact, but one more stored key
  per room, and the overlap with dropping doubles does the same.
