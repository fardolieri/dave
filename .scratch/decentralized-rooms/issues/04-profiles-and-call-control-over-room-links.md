# 04 · Profiles and call control over room links; server presence is keys only

Status: open
Blocked by: 01
Spec: [§6](../spec.md)

**What to build:** Names, profile pictures, call membership, mute, share, and subscribe move from the socket onto room links. Profiles are signed by their owner. The server's presence shrinks to public key, fingerprint, and the participant flag it needs for TURN minting. The server no longer knows anyone's name.

## Acceptance

- [ ] Signed `profile` record (own signing label, unit-tested), sent after the proof and on every change, stored in the address book.
- [ ] `auth` no longer carries a name or picture; `name` and `picture` socket messages removed.
- [ ] Before a link verifies, a member shows fingerprint plus last known name from the address book, marked connecting.
- [ ] `call`, `mute`, `share`, `subscribe` on room links. The server stops relaying `subscribe` and stops publishing `muted` and `sharing`. Share tiles and mute icons come from peer state.
- [ ] `join` and `leave` on the socket remain only for TURN minting and revocation, and for the participant flag in presence.
- [ ] Spec §3 to §5 of the P2P friends chat spec amended.

## Verify

- Playwright: this ticket's `test.fixme` cases in `e2e/decentralized.spec.ts` switched on, and the whole suite (`e2e.yml`, Chromium and Firefox) green. The existing specs must pass unchanged: they pin what friends see.
- `pnpm typecheck`, then `pnpm test`, then `pnpm build`.
- Driver, three browsers: rename, emoji, mute, share, and subscribe all behave as before; the socket traffic (dev hook or test) carries no names.
