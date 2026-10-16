# 03 · Files of any size, streamed to disk

Status: shipped 2026-10-16 to prod (dd3b87e), nightly e2e green first
Blocked by: 01

**Why:** ticket 01 reads, hashes and stores a file whole, so it caps files at 100 MB.

**What to build:** a large file is hashed in pieces (a hash per piece, signed in the announcement as their list's hash),
pulled piece by piece with resume after a lost link, and written straight to disk: the File System Access API where
there is one, a download streamed through the service worker elsewhere. The sender serves it from the `File` it picked,
so it is available only while that tab stays open.

## Built (2026-10-16)
- Over PIECED_FROM (16 MB) a file goes in pieces of 1 MB. Its announced `hash` is the SHA-256 of the list of piece
  hashes, and the announcement says the piece size (`piece`). The sender hashes it a piece at a time and serves it from
  the file picked, so it can be pulled while that tab is open, and later from friends who pulled it (ticket 02).
- A puller asks for the list first (`{ t: 'list' }`), checks it against `hash`, keeps it, then asks for the bytes from
  the first piece not on disk. Each piece is checked against the list and written to the Origin Private File System at
  its place in a segment of 16 MB, each its own OPFS file written once (an OPFS writer that keeps existing data starts
  as a copy of it, so one file reopened to commit copied all of it each time). Progress is saved as each segment closes;
  a pull that stops keeps its complete segments and goes on after them, after a reload too. One lock per file, across
  tabs and rooms, keeps two pulls of it from writing at once.
- Complete large files are listed in `bigFiles`, outside the 300 MB budget, and swept after three days; partial ones
  three days after their pull last moved.
- Not done: the sender keeps no copy, so a large file is gone with her tab unless a friend pulled it. Frames that come
  while a segment is written wait in memory (a data channel has no backpressure on the receiving side); writes to a
  fresh file are fast, so it is small.
- A browser without OPFS writers (Safari before 26), or out of room, says it cannot keep files this large; such a
  browser could pull files of 16 to 100 MB whole before. Old apps cannot pull a pieced file (they see it
  damaged) until they reload; files of 16 MB and less go whole as before.

## Report of 2026-10-16: a 24 MB download started again from 0
A friend on an iPhone pulled a 24 MB photo, left the app 20 s in, and came back to "⬇ 24 MB" instead of "Resume": only
whole segments of 16 MB were kept, so a pull under 16 MB kept nothing, and a file under 32 MB never resumed. The
segments were there because a page's OPFS writer (`createWritable`) commits only on close and copies the whole file to
go on. Now a worker (client/filewriter.ts) writes the file in place with `createSyncAccessHandle`, one OPFS file named by
its hash, each piece flushed and the progress saved before the next: a pull cut off without warning loses at most the
piece under way. Writing in place came to Safari in 15.2, so iPhones before Safari 26 can now keep large files too.
Complete files in segments from before (`<hash>.<n>`) are still read; a pull stopped on the old app starts again, once.
