# 30 · Large signaling frames, and refused frames said honestly

Status: shipped 2026-09-27 to nightly and prod (80446b7)
Asked for 2026-09-27: a friend on a flaky line saw "Not sent: unrecognised message." (23:57 on Sep 26) in his chat, Daniel
did not. His problem report never arrived (his events stopped at 23:56). After the welcome, the server only answers
"unrecognised message" without a `ref` to a frame over the 16,384-unit cap or one that is not JSON; every frame the
client writes is well-formed, and only signaling has no size bound (a description lists every gathered candidate;
candidate batches are capped by count, not size). So a signal was dropped, and the client, seeing no `ref`, called it a
text. That renegotiation never reached the other side, which fits the same evening's report that he stayed audible
while shown offline. Not proven: nothing logged the frame. Decided with Daniel: raise the server cap rather than shrink
what the client sends; make refusals attributable; log them on the server.

## Built
- `core/protocol.ts`: `MAX_MESSAGE_BYTES` 512 × 1024. `Invalid` carries `ref`, the type the frame claimed: from the
  parsed `t`, or for a frame over the cap from its prefix (`{"t":"…"`, the client always writes `t` first). An
  oversized frame says "message too large".
- `core/room.ts`: an authenticated invalid frame is answered with that `ref`, and the outcome carries `rejected`
  (sender key, reason, ref, length). Rate limited frames keep their error but are not logged (a flood would log a
  flood); the rate limit also bounds logged ones. Refusals before authentication are unchanged.
- `worker/telemetry.ts`: `logRejected` writes one `frame rejected` line to the Worker logs and, where `POSTHOG_KEY` and
  `POSTHOG_HOST` are set (prod and nightly vars in `wrangler.jsonc`, the public project token; not e2e, blanked in the
  vitest config), captures `server_frame_rejected` on the sender's person: `ref`, `reason`, `length`, never the frame.
- `client/room.ts`: an error without `ref` goes to the console like signal and ice ones, never into the chat.
  "Not sent" is only for `text`; other room actions keep "Dropped".
- Spec §5 amended.

## Verify
- `pnpm typecheck`, `pnpm test`: a 20 KB offer relays through the Room; a frame over the cap comes back as
  `{ reason: 'message too large', ref: 'signal' }`; invalid texts, names and pictures carry their `ref`.
- `pnpm e2e`.
- After deploy: `server_frame_rejected` in PostHog and `frame rejected` in the Worker logs. None expected in normal use;
  one showing `ref: 'signal'` with a large `length` would confirm the diagnosis.
