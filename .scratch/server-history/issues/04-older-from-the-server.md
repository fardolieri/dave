# 04 · Older texts from the server, on scrolling up

Status: dropped (2026-11-08): a browser keeps every text of the window, with no cap, and a long absence syncs in pages
(spec, decision 8). "Show older messages" unfolds what the browser holds; it never asks the server.
Blocked by: 01

**Why:** a browser keeps a room's newest 500 texts, and a sync brings the newest 500 at most. What the server keeps
beyond that cannot be read anywhere.

**What to build:** scrolling to the top of a room's log asks the Room for the 100 kept before the oldest line shown
(`{ t: 'sync', before }`), shown above, not written to the history.
