# 03 · Files of any size, streamed to disk

Status: needs-triage
Blocked by: 01

**Why:** ticket 01 reads, hashes and stores a file whole, so it caps files at 100 MB.

**What to build:** a large file is hashed in pieces (a hash per piece, signed in the announcement as their list's hash),
pulled piece by piece with resume after a lost link, and written straight to disk: the File System Access API where
there is one, a download streamed through the service worker elsewhere. The sender serves it from the `File` it picked,
so it is available only while that tab stays open.
