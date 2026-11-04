# 03 · Private conversations as rooms of two, kept and synced like any room

Status: open, design to agree with the owner first
Blocked by: 01

**Why:** a private text (ADR 0007) goes only to a friend attached to a room both share, and is never kept: sent while
they are away, it is not sent. The owner wants private conversations to sync like rooms (2026-11-05). It is fine that
the server could learn who talks to whom in principle, but someone reading the server should see no more than a room
of two random people (owner, 2026-11-05).

**Direction (to write up as an ADR and agree):** each private conversation is a room of its own, its secret derived by
both browsers from their private text keys (ECDH, as ADR 0007 seals with). Each browser enters it with a key of its
own for that conversation only, never its identity, and tells the other friend, sealed and signed by its identity, that
the key is its own. The server, and what it keeps, then shows a room with a random id and two keys found nowhere else.

**What it cannot hide:** IP addresses and timing to someone watching connections live (a browser opens its rooms and its
conversations from one address at about the same time), that the room has two members, and how much they write.
