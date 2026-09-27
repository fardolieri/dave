# 32 · PostHog only with consent

Status: shipped 2026-09-27 to nightly and prod (93aea52)
Asked for 2026-09-27: Daniel: "Lets make the posthog telemetry an opt in feature. I dont want anyone to accuse me of
'spying' on them without consent and rightly so." Until now every visitor got PostHog cookies, events, exception capture
and a masked session replay from the first page load, unasked; the server also sent `server_frame_rejected` under the
sender's key. Decided with Daniel: a one-time notice in the first person ("Want to help me find bugs?"), asked by the dave
mascot peeking in with a speech bubble like on Josh Comeau's blog, a permanent toggle,
problem reports still sent on request, the server event only for those who opted in. Takes over the telemetry part of the
shelved decentralized-rooms ticket 05.

## Built
- `client/posthog.ts`: a wrapper with the SDK's `capture`/`identify`, so no call site changed. posthog-js is loaded with a
  dynamic import only after a yes (`dave.telemetry = on`); before it nothing goes out and nothing is stored, and events
  are dropped, not kept. Captures between the yes and the SDK having loaded are queued, so page-load events survive.
  A no (or stopping later) resets and opts the SDK out and removes posthog-js's local and session storage and cookies;
  every load without consent does the same, for browsers that had PostHog before. A parent-domain cookie is deleted
  domain by domain until it is gone, never on an IP (Firefox logs each rejected cookie). `captureOnce` posts a single event
  straight to `/i/v0/e/` (no SDK, cookies or person profile) when there is no opt-in.
- `client/App.tsx`, `client/dino.svg`: the notice (`TelemetryNotice`) while unanswered: the headset dino
  (`docs/logo/dave-headset-traced.svg`, the favicon's colours, without its tile and the background gaps between horns and
  headband, mirrored to face the bubble) rises
  from behind the composer's edge, and a slate speech bubble pops in beside it, its tail at the dino's mouth. "Sure!" and "Maybe later" alike; not a
  modal; no motion under `prefers-reduced-motion`. "Help find
  bugs" / "Stop helping find bugs" at the bottom of the sidebar. The report dialog says it goes to PostHog, and without
  the opt-in that only this report goes.
- `client/diagnostics.ts`: reports through `captureOnce`.
- `core/protocol.ts`, `core/room.ts`, `client/room.ts`: `auth` carries `telemetry: true` with consent; a new
  `{ t: 'telemetry', on }` changes it live. Kept in the socket attachment, never in presence. `rejected` carries it, and
  `worker/telemetry.ts` sends `server_frame_rejected` only with it; the Worker log line stays for everyone.
- Review fixes: a change of the answer goes to the server only once the socket is let in (before the welcome any frame
  but the auth counts as a failed attempt, and the reply read as a refusal of the room); a change during the handshake
  goes out with the welcome. A posthog-js load that fails (blocker, dropped line) resets so a later yes retries; the
  pre-load queue is bounded and skipped when PostHog is not configured.
- Spec §7.7 added, §4 frame caps and §7.5 amended.
- e2e fixtures seed `on` by default (the suite behaved like that before); `telemetry: null | 'off'` for the new tests.
  Without posthog-js parsed at startup the app opens its socket sooner, and Firefox's "can't establish a connection"
  for a socket a reload or take-over closed mid-connect now shows in the local ticket 25 test; the known-harmless
  pattern took only `wss:` (deployed) and now takes `ws:` too.

## Verify
- `pnpm typecheck`, `pnpm test` (parser and the server-side flag, incl. not in presence), `pnpm e2e`.
- New `e2e/privacy.spec.ts`: a fresh browser sees the notice, chats and joins a call with zero PostHog requests and no
  `ph_` storage; a no holds across a reload; a yes starts PostHog and tells the server (live and at the next auth);
  stopping tells the server, clears storage, and nothing more is sent after a reload; a report without the opt-in goes as
  exactly one request to `/i/v0/e/`.
- A yes while the challenge is held back: the room still connects and the auth carries it (fails on the unfixed client
  with exactly that refusal).
- After deploy: a fresh headless browser on prod made no PostHog request and stored nothing (landing page); both Workers serve the new bundle.

## Consequences
- Expect far fewer events and replays; the friend from ticket 30 would now also have to opt in for `server_frame_rejected`
  to show up.
