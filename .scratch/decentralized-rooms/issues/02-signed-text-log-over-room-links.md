# 02 · Signed text log over room links, synced on connect

Status: open
Blocked by: 01
Spec: [§5.1 to §5.3](../spec.md)

**What to build:** Texts become signed messages that travel between peers over room links and are merged by union. When two members' link opens, they exchange what the other is missing. The server no longer relays text or vouches for its author. **Deploy together with 03**: removing the server relay without the mailbox would lose messages for friends who are offline.

## Acceptance

- [ ] Message format, signing string, and checks per spec §5.1 in `src/core/` (runtime-neutral, unit-tested: round trip, tampered text, name, room or `at`, wrong author key, future `at`, over-length).
- [ ] Monotonic `at` per author; display order `(at, id)`.
- [ ] History in IndexedDB keyed by `id`, capped at the newest 500. Existing histories migrate: old entries get a derived `id` and no signature, and are shown but never forwarded or synced.
- [ ] Live push to every verified link; first sight of an `id` forwards it once to the other links.
- [ ] `have` / `want` / `msgs` sync after the membership proof, split under the 16 KB frame cap, respecting the horizon rule.
- [ ] "Clear history" sets a watermark; synced or forwarded messages at or below it are ignored.
- [ ] Cues and unread counts per spec §5.3: no chime for sync of old messages on load.
- [ ] Server `text` removed from `ClientMessage` and `ServerMessage` and from `src/core/room.ts` (in the same deploy as 03).
- [ ] The composer is enabled while at least one verified link or the socket is up; the "you may have missed messages" notion goes away once sync and mailbox cover the gap.

## Verify

- Playwright: this ticket's `test.fixme` cases in `e2e/decentralized.spec.ts` switched on, and the whole suite (`e2e.yml`, Chromium and Firefox) green. The existing specs must pass unchanged: they pin what friends see.
- `pnpm typecheck`, then `pnpm test`, then `pnpm build`.
- Driver: A and B chat; C joins later and receives the history from either. A and C have no direct link (block it in the driver) and still see each other's texts via B.
- A message edited in transit by a test peer is dropped with a warning.
