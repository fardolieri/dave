# 55 · Flake: the preview Worker answered a socket upgrade with 500, five times in a row

Status: open, cause is Cloudflare's; the Room is asked twice since 54ad1a5 (shipped 2026-10-16 to prod), which saved
6 of the 7 failed asks seen since; one upgrade failed both asks and was answered 500
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

## Since the second ask (2026-10-16)
Read from PostHog `server_upgrade_failed` the same evening. Every event so far came from nightly or a preview, none from
live. Before 54ad1a5: one on nightly (14:19 UTC) and one on a preview (15:00). After it, on a preview (`attempt` set):
- 15:25:39.856 attempt 1, then 15:25:39.958 attempt 2: both asks failed, the friend got the 500.
- 15:31:37 to 15:31:40 four times attempt 1, 15:40:35 and 15:40:36 twice attempt 1: no attempt 2 followed, so the second
  ask went through. (A good upgrade is not counted, so how often the Room is asked at all is not known.)
All were "internal error; reference = …", neither retryable nor overloaded. The second ask helps; it does not make the
error go away. Seven came in 25 minutes on previews while the attachments PRs (#67 to #72) were being pushed and
deployed one after another; whether those minutes match a deploy was not checked.

## Next (2026-10-16)
- Watch whether any `server_upgrade_failed` with attempt 2 shows up on live. If it does, or if previews keep seeing it,
  ask Cloudflare support with the reference ids above.

## Seen 2026-10-18, not at a deploy
The preview run of PR #78 (39080940242, head 25dadeb, against `dave-pr-78`) had two tests fail only on Alice's console
line "Error during WebSocket handshake: Unexpected response code: 500", both passed on the retry: Chromium shard 3,
`privacy.spec.ts:10` (at 00:00:14), and Chromium shard 2, `attachment.spec.ts:424` (at 00:00:21).
PostHog has three `server_upgrade_failed` from `dave-worker-preview`, all "internal error; reference = …":
- 00:00:06.351 attempt 1, `overloaded` true (the first sighting with it set);
- 00:00:08.540 attempt 1, and 00:00:12.237 attempt 2: both asks failed, the friend got the 500.
The preview's deploy had finished at 23:57:23, almost three minutes before, so this one was not a Room reset by a deploy.
It came while the run's 16 shards were all opening rooms on the same preview Worker at once. Two friends got a 500, yet
only one attempt 2 was reported: an event was lost on the way, or a 500 came from somewhere the catch does not reach.
