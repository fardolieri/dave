# 03: Presence and text for visitors

**What to build:** Two friends with the page open see each other in the Online list and chat in the always-visible centre column. Presence is derived from attached sockets and broadcast as full snapshots. Text is relayed live and never stored. When the server socket drops, the banner says so, chat is disabled with a reason, and the client reconnects with backoff.

**Blocked by:** 02 Invite link and identity gate.

**Status:** ready-for-agent

- [ ] Per-socket attachment holds public key, display name, role, join sequence, sharing flag, muted flag; presence is rebuilt from attachments after the object wakes from hibernation (test by simulating eviction).
- [ ] Full presence snapshot broadcast on every change; sidebar shows Online first with avatar initial, name, fingerprint, and a "new" badge for keys not in the local seen-keys list; the user is listed last in Online.
- [ ] Text relayed to every attached socket, tagged by the server with the sender's public key; 2,000 character cap; URLs auto-linked; no persistence anywhere.
- [ ] Client ping every 30 s answered by the hibernation auto-response without waking the object.
- [ ] Per-socket rate limit of 20 messages per second, burst 40; excess dropped with an error frame; tested.
- [ ] Name clash warning when another attached socket uses the same display name, showing the user's own fingerprint.
- [ ] Server banner states: reconnecting, then unavailable after 30 s; exponential backoff capped at 30 s; text input disabled with reason; "you may have missed messages" line after reconnect.
