# 09: Text cue and local history

**What to build:** A soft audio cue plays when someone else's message arrives. The chat you have received is kept in this browser, so reopening the page shows the recent conversation again, with a way to clear it. The server is untouched: it still relays text and stores nothing.

**Blocked by:** 03 Presence and text for visitors.

**Status:** done (2026-09-07), awaiting deploy

- [x] A quiet two-note cue plays for messages from others, never for your own or for restored history; it needs the same one-time gesture unlock as the other chimes.
- [x] Received texts are stored in IndexedDB per browser, capped at the most recent 500, loaded on start, de-duplicated by sender key plus server timestamp; system lines are not stored. No protocol change.
- [x] A "clear history" control empties the local store.

## Notes

- 2026-09-07: a first cut also stamped each text with the recipients the server delivered it to, so senders could see who missed a message. The owner withdrew it: the server should do as little as possible beyond signaling. Reverted before it was pushed; read receipts stay out of scope.
- Verified with the driver: the receiver counted three cues for three incoming messages and the sender none for her own; three messages survived a reload; "clear history" emptied them.
