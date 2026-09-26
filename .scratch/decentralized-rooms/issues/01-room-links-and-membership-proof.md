# 01 · Room links between all members, with a peer membership proof

Status: open
Blocked by: none
Spec: [§3, §4](../spec.md)

**What to build:** Every member of a room, visitor or participant, holds a data-only peer connection (a room link) to every other online member. When it opens, both sides prove to each other that they hold the room's member key, which the server never sees. Nothing else travels on the link yet: text, presence, and call control stay on the socket until tickets 02 to 04. This ticket already closes a real hole: today the server holds the auth key and could invent a member.

## Acceptance

- [ ] `memberKeyOf(secret)` in `src/core/rooms.ts` (label `member-key`), never sent anywhere.
- [ ] `signal` accepted between any two attached members, carrying `link: 'room' | 'call'`. `call` keeps today's rule (both participants). Descriptions are signed and verified per ADR 0004 for both kinds.
- [ ] Visitors can request TURN credentials for room links; revoked on socket close as today.
- [ ] One room link per pair per room, one negotiated channel (`id: 0`), lower public key offers, perfect negotiation with `isPolite`. ICE restart and the stuck-connecting watchdog apply as for call connections, with the same relay fallback (ticket 22 of the build).
- [ ] Membership proof per spec §4.2 in `src/core/` (runtime-neutral, unit-tested): hello and proof round trip, wrong key, swapped key order, replayed nonce, proof relabelled for another key.
- [ ] A link that fails the proof closes; the member shows as unverified; `member_proof_failed` is filed.
- [ ] Presence shows each member's room link state: direct, relayed, connecting, unreachable, unverified.
- [ ] Several rooms at once: links are per room; closing a room closes its links.

## Verify

- Playwright: this ticket's `test.fixme` cases in `e2e/decentralized.spec.ts` switched on, and the whole suite (`e2e.yml`, Chromium and Firefox) green. The existing specs must pass unchanged: they pin what friends see.
- `pnpm typecheck`, then `pnpm test`, then `pnpm build`.
- Driver, three browsers, two of them visitors: every pair shows a verified direct room link within a few seconds; a call among two still works.
- A test client with the right auth key but the wrong member key is admitted by the server and refused by every peer.
