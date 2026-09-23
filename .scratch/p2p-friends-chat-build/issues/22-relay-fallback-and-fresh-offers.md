# 22 · Relay fallback after a stalled attempt; a fresh offer starts a fresh connection

Status: built 2026-09-23, relay path awaiting a TURN-enabled check
Reported 2026-09-23 18:05 UTC through the in-app problem report: "A friend cannot connect... It stays at the connecting
phase". PostHog showed, from the reporter's Chrome: signalling stable with both descriptions, ICE "connected", the DTLS
handshake never completing, selected pair host to host, three watchdog attempts (15, 30, 60 s) in the identical state.
Brave in the same call reached that friend directly within seconds; when the friend came back after a reload their
connection to Chrome came up relayed. The friend's browser sends no PostHog events at all, so their side is invisible.
Daniel notes the friend has flaky internet in general; the two changes here make the app robust to the case either way.

## Built
- `core/mesh.ts` `transportPolicyFor(attempt, turnAvailable)`: `all` on the first attempt, `relay` once an attempt has
  stalled and TURN is configured. `client/call.ts` builds the connection with that policy; the stalled-attempt map now
  lives beside `peers`, is read by `createPeer`, cleared on success (as before), on `left`, when a participant vanishes
  from presence, and on my own leave. My relay candidates alone put every pair through the TURN server, so one side
  falling back is enough.
- `core/dtls.ts` `isFreshConnection(heldRemoteSdp, offerSdp)`: the offer's fingerprints differ from the description we
  hold. `onSignalNow` treats such an offer like one from a dead connection: close and start over. Before, only
  server-lost, ICE-failed or closed connections were restarted, so a rebuild on one side was applied to the stuck
  connection on the other as a renegotiation with a new certificate, which never succeeded either (the "have-local-offer,
  no answer, zero remote candidates" watchdog reports of 20, 22 and 23 Sep are the other side of that).
- `closePeer` no longer drops the per-identity signal chain: a restart from inside a handler must keep the candidates
  behind the fresh offer queued until `setRemoteDescription` on the new connection is done.
- Problem reports and `peer_connecting_slow` carry `relayOnly` / `relay_only`. Dev hook: `peers()` shows `relayOnly`,
  `generation` (which RTCPeerConnection of this tab) and `stuck`; `rebuild(name, stalled = 0)` does what the watchdog does.
- Spec §8.2 amended.

## Verify
- `pnpm typecheck`, `pnpm test` (124), `pnpm build`.
- `REBUILD_CHECK=1 node scripts/drive.mjs --join http://localhost:5199 <secret> Alice Bob` against `pnpm dev --port 5199`,
  2026-09-23: Alice rebuilds toward Bob; Bob's connection generation goes 1 to 2 (he started over on the new certificate),
  both badges direct again after 1 s, audio bytes flowing. Three browsers with `--join`: direct on every pair after 1 s.
- Open: the local `.dev.vars` carries the TURN placeholder, so the dev server hands out STUN only and the relay-only
  rebuild reads `relayOnly=false` by design. With a real `TURN_KEY_API_TOKEN` in `.dev.vars` the same driver run should
  print `rebuilt Bob, relayOnly=true` and both badges `via relay` with audio flowing. The rule itself is unit-tested.
