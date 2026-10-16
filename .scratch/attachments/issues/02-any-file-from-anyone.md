# 02 · A file comes from any friend who has it

Status: needs-triage
Blocked by: 01

**Why:** with ticket 01 a file reaches a friend only while its sender is online, and the sender uploads it once per friend.

**What to build:** a friend who wants a file asks the friends online which of them have it (a `has` question on the
Room, or on open file links) and pulls from one of them, falling back to the next. The hash in the signed announcement
makes any holder as good as the sender.
