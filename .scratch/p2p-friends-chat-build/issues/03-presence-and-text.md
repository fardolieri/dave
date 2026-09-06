# 03: Presence and text for visitors

**What to build:** Two friends with the page open see each other in the Online list and chat in the always-visible centre column. Presence is derived from attached sockets and broadcast as full snapshots. Text is relayed live and never stored. When the server socket drops, the banner says so, chat is disabled with a reason, and the client reconnects with backoff.

**Blocked by:** 02 Invite link and identity gate.

**Status:** in-progress (branch `build/03-presence-text`, under review)

- [x] Per-socket attachment holds public key, display name, role, join sequence, sharing flag, muted flag; presence is rebuilt from attachments after the object wakes from hibernation (test by simulating eviction).
- [x] Full presence snapshot broadcast on every change; sidebar shows Online first with avatar initial, name, fingerprint, and a "new" badge for keys not in the local seen-keys list; the user is listed last in Online.
- [x] Text relayed to every attached socket, tagged by the server with the sender's public key; 2,000 character cap; URLs auto-linked; no persistence anywhere.
- [x] Client ping every 30 s answered by the hibernation auto-response without waking the object.
- [x] Per-socket rate limit of 20 messages per second, burst 40; excess dropped with an error frame; tested.
- [x] Name clash warning when another attached socket uses the same display name, showing the user's own fingerprint.
- [x] Server banner states: reconnecting, then unavailable after 30 s; exponential backoff capped at 30 s; text input disabled with reason; "you may have missed messages" line after reconnect.

## Notes

- 2026-09-06: built on branch `build/03-presence-text`. 32 tests in workerd. Verified with real headless Chromium profiles via `scripts/drive.mjs` (a DevTools-protocol driver that seeds secret and name and reads the DOM): three browsers see each other with the user last in Online and "new" badges on unseen keys; a message with a URL reaches everyone with sender fingerprint and time; two people named Dave both get the clash warning with their own fingerprint.
- Outage test against `vite preview` (no dev client to reload the page): server killed 19 s, browsers showed the reconnecting banner within a second, reconnected within a few seconds of the server returning, showed "Reconnected. You may have missed messages.", and presence came back from attachments. The 30 s "unavailable" escalation was not reached in that window.
- Eviction: the Room class has no instance fields (asserted by a test that inspects the live instance), so eviction cannot lose anything; presence is a pure function of attachments.
- Learned: touching Worker sources hot-reloads workerd without dropping hibernated sockets, and the Vite dev client reloads the page when its own connection returns, so reconnection must be tested against the preview build.
