# 55 · Flake: the preview Worker answered a socket upgrade with 500, five times in a row

Status: open, cause not known
Seen 2026-10-15: the preview run of PR #64 (38777674741, head 986231c, against `dave-pr-64`), Chromium, shard 3, passed on
the retry: `resilience.spec.ts:237` "a socket the server never answers is given up and tried again, and the room
connects". Alice stayed on the banner; her console had five "Error during WebSocket handshake: Unexpected response code:
500" for one room id.

## What is known
- The 500 came before the handshake, on the upgrade. `src/worker/index.ts` answers 426, 429 and 404 itself and never
  500: it is an exception in the Worker or in the Room's `fetch`, or Cloudflare's own.
- The branch changed no Worker code before the handshake (only the handling of `sealed` frames, which runs after the
  welcome). The preview run of the commit before (3609bda, same server code) passed, and so did the retry.
- The test holds Alice's first socket unanswered (`wire.unanswered = 1`); each retry then got 500 from the same Room.

## Next
- Tail the Worker's logs (`wrangler tail dave-pr-<n>`) while the test runs against a preview, or look in the Cloudflare
  dashboard's logs for dave-pr-64 around 2026-10-15 17:32 UTC, for the exception behind the 500.
- Check whether a Room whose first socket never finished its handshake is left in a state that throws on the next upgrade.
