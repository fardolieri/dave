# 55 · Flake: the preview Worker answered a socket upgrade with 500, five times in a row

Status: open, cause not known; diagnostic on branch flake/55-upgrade-500, 2026-10-15: the Worker reports the exception
Seen 2026-10-15: the preview run of PR #64 (38777674741, head 986231c, against `dave-pr-64`), Chromium, shard 3, passed on
the retry: `resilience.spec.ts:237` "a socket the server never answers is given up and tried again, and the room
connects". Alice stayed on the banner; her console had five "Error during WebSocket handshake: Unexpected response code:
500" for one room id.

Seen before, 2026-10-14: the nightly e2e run for 54ecfd1 (38627817647), job 116071368862, Chromium shard 5, passed on the
retry: `settings.spec.ts:275` "a friend's volume and the master volume multiply, and survive a reload" failed only on the
console line "WebSocket connection to 'wss://dave-nightly…/ws/…' failed: Error during WebSocket handshake: Unexpected
response code: 500", once, on Alice's socket after her reload. So not only previews: nightly too, and on a Room that had
answered before.

## What is known
- The 500 came before the handshake, on the upgrade. `src/worker/index.ts` answers 426, 429 and 404 itself and never
  500: it is an exception in the Worker or in the Room's `fetch`, or Cloudflare's own.
- The branch changed no Worker code before the handshake (only the handling of `sealed` frames, which runs after the
  welcome). The preview run of the commit before (3609bda, same server code) passed, and so did the retry.
- The test holds Alice's first socket unanswered (`wire.unanswered = 1`); each retry then got 500 from the same Room.

## Diagnostic (2026-10-15)
`src/worker/index.ts` now catches what throws between the upgrade's arrival and the Room's answer (the rate limiter, the
Room's stub, the Room's `fetch`), answers 500 as before, and reports it: a `console.error('upgrade failed', …)` line and a
`server_upgrade_failed` PostHog event (distinct id `dave-worker-<target>`, no person profile) with the error's `name`,
`message` and Cloudflare's `retryable` and `overloaded` flags. Previews and nightly send it (they have POSTHOG_KEY), so the
next sighting can be read with the HogQL recipe: `select timestamp, properties from events where event =
'server_upgrade_failed' order by timestamp desc`. A Durable Object reset by a deploy ("code was updated") is `retryable`; if
that is it, the Worker should try the Room once more on a retryable error rather than answer 500.

## Next
- Tail the Worker's logs (`wrangler tail dave-pr-<n>`) while the test runs against a preview, or look in the Cloudflare
  dashboard's logs for dave-pr-64 around 2026-10-15 17:32 UTC, for the exception behind the 500.
- Check whether a Room whose first socket never finished its handshake is left in a state that throws on the next upgrade.
