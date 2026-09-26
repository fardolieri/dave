# 03 · Encrypted mailbox on the Room for offline delivery

Status: open
Blocked by: 02
Spec: [§5.4](../spec.md)

**What to build:** Option B. Every text is also deposited on the Room, encrypted with a mailbox key derived from the secret that the server never sees. On connect, a client fetches what it missed and merges it after checking the author's signature. Friends who were never online at the same time still receive each other's messages. The server can withhold entries, but cannot read or forge them.

## Acceptance

- [ ] `mailboxKeyOf(secret)` (label `mailbox-key`), imported as a non-extractable AES-GCM key.
- [ ] Seal and open in `src/core/` with padding to 256-byte buckets, `aad = roomId + id` (unit-tested: round trip, wrong key, swapped `aad`, truncated blob).
- [ ] `deposit` and `fetch` / `mail` added to the protocol with validation (blob size cap, `at` sanity) and their own rate bucket.
- [ ] The Room stores entries in Durable Object storage, keeps the newest 500 and drops entries older than 30 days at deposit time. Check the free-tier storage and row-write limits and record them in the ticket; the design must stay inside them for a five-friend room with heavy chat.
- [ ] The author deposits after sending; a failed deposit retries on reconnect from a small local outbox.
- [ ] Every (re)connect fetches since the newest held `at` minus 10 minutes; entries are opened, verified as in 02, and merged.
- [ ] Shipped in the same deploy as 02.

## Verify

- Playwright: this ticket's `test.fixme` cases in `e2e/decentralized.spec.ts` switched on, and the whole suite (`e2e.yml`, Chromium and Firefox) green. The existing specs must pass unchanged: they pin what friends see.
- `pnpm typecheck`, then `pnpm test` (including a workerd test that the Room stores, trims, and serves entries it cannot read), then `pnpm build`.
- Driver: A sends while B is closed; A closes; B opens and receives the message with nobody else online.
- A tampered stored blob is dropped by the client.

## Notes

- The server still learns who deposited when and roughly how big. Accepted in the spec.
