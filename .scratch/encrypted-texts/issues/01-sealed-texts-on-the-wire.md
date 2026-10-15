# 01 · Texts travel sealed: encrypted with a key from the secret, signed by their writer

Status: in progress 2026-10-15 (branch `crypto/encrypted-text`)
Blocked by: none
Decision: [ADR 0005](../../../docs/adr/0005-texts-sealed-with-a-key-from-the-invite-secret.md)

**Why:** texts are to be stored in the cloud later (ticket 02). Before anything is stored, the server must stop being able
to read texts or forge who wrote them.

**What to build:** clients send `{ t: 'sealed', sealed, id }` instead of `{ t: 'text', text, id }`; the Room relays it
tagged with `from` and `at`, without reading it. The Room refuses a plain `text` as from an app out of date (no transition
period, owner 2026-10-15). Friends open each text, check the writer's signature against the attributed identity, and drop
what fails with a `text rejected: <reason>` warning and a `text_rejected` PostHog event.

## Acceptance

- [x] `textKeyOf(secret)`, non-extractable AES-GCM, label `text-key` (`src/core/rooms.ts`).
- [x] `sealText` / `openText` in `src/core/sealed.ts`: signature inside, padding to 256-byte buckets, room id and id as
  additional data. Unit tests: round trip, wrong key, other room or id, other attributed writer, a member forging another,
  tampered and truncated blobs, composer rules, the longest text within `MAX_SEALED_LENGTH` (`test/sealed.test.ts`).
- [x] Protocol and Room: `sealed` both ways, id required, size capped; plain `text` refused with `OUT_OF_DATE`.
- [x] Client seals in the order written and opens in the order received; local history unchanged (no migration).
- [x] Browser tests (`e2e/adversary.spec.ts`): no text in plain on any frame; a reattributed or tampered text is not shown;
  a plain text gets "Not sent: this app is out of date…" and reaches nobody.

## Not in this ticket

- Storing texts on the Room (ticket 02, not written yet). The shelved
  `.scratch/decentralized-rooms/issues/03-encrypted-mailbox.md` has a design to start from.
- Encrypting names, pictures, presence or call control.
