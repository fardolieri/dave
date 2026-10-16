# 02 · A file comes from any friend who has it

Status: in progress
Blocked by: 01

**Why:** with ticket 01 a file reaches a friend only while its sender is online, and the sender uploads it once per friend.

**What to build:** a friend who wants a file asks the friends online which of them have it (a `has` question on the
Room, or on open file links) and pulls from one of them, falling back to the next. The hash in the signed announcement
makes any holder as good as the sender.

## Built (2026-10-16)
No new frames: a pull asks the friends who announced the file, newest first, then every other friend online in turn,
with an ordinary pull. A friend without it answers `none` ("not there"), one busy or out of reach is passed over, and
the next is asked at once. Only when nobody is left does the round end, on its most hopeful reason (busy, then
unreachable or lost, then not there), and the retry schedule of ticket 05 or the wait for a friend takes over. Friends
learn of nothing they did not see announced: only those in the room are asked, and only for a file announced there.

Not covered: a friend who was not online when a file was announced never sees it (the Room keeps no history).
