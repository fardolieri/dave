# 05 · Encrypted signaling, telemetry opt-in, ADR 0005

Status: open
Blocked by: 02, 03, 04
Spec: [§7, §8](../spec.md)

**What to build:** The last pieces before the claim in spec §1 holds. Signaling payloads are sealed so the server no longer sees SDP or IP addresses; call-link signaling travels on the room link once one exists; PostHog becomes opt-in. The decision is recorded in an ADR, and the docs stop describing the server as trusted.

## Acceptance

- [ ] `signalKeyOf(secret)` (label `signal-key`); `SignalData` sealed with `aad = from + to + link` (unit-tested). The server validates only the envelope size.
- [ ] Call-link descriptions and candidates go over the room link when it is verified, over the socket otherwise.
- [ ] PostHog analytics and session replay off by default, with a per-browser opt-in and a plain explanation. Problem reports still work and say they go to PostHog.
- [ ] ADR 0005 "Peers, not the server, carry text, presence, and control", superseding the "no data channels" and "all control over the WebSocket" parts of ADR 0001 and the attribution trust in ADR 0003. ADR 0003 and 0001 get amendment notes.
- [ ] `CONTEXT.md` gains **Room link** and **Mailbox**; Presence, Signaling, and Visitor definitions updated. README states the claim from spec §1 and its limits.

## Verify

- Playwright: this ticket's `test.fixme` cases in `e2e/decentralized.spec.ts` switched on, and the whole suite (`e2e.yml`, Chromium and Firefox) green. The existing specs must pass unchanged: they pin what friends see.
- `pnpm typecheck`, then `pnpm test`, then `pnpm build`.
- Driver: a call among three, with a server-side log of relayed frames, shows no SDP, candidates, names, or text on the socket.
- A fresh browser sends no PostHog events until opted in.
