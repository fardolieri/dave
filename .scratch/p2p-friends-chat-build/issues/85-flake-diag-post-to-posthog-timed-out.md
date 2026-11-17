# 85 · Flake: the /diag POST that goes on to PostHog took more than 15 s

Status: open; cause not looked for
Type: flake

Seen 2026-11-17, the preview run of #155 at 51552da (run 44146139627, Chromium shard 4), passed on its retry in 5 s:
`privacy.spec.ts:154` "the Worker really passes /diag on to PostHog: scripts and remote config to its assets host, the
rest to its ingest host". #155 adds `/yt-search` to the Worker, a route after `/diag`'s, and changes nothing on it
(worker/posthog.ts). First sighting in the ledger.

```
TimeoutError: apiRequestContext.post: Timeout 15000ms exceeded.
  - → POST https://dave-pr-155.danielmittereder.workers.dev/diag/flags/?v=2
> 165 |   expect((await api.post('/diag/flags/?v=2', { headers, data: { token: key, distinct_id: 'e2e-proxy-check' } })).status(), 'a POST, body and all').toBe(200);
```

The two GETs before it (remote config, the recorder script) answered. The POST is the only step that waits on
PostHog's EU ingest host itself, a third party, through the preview Worker.

## Next
Whether PostHog's `/flags` was slow then (its status page for 2026-11-17 ~18:19 UTC), or the Worker's forward held the
request (its logs for dave-pr-155, while the preview lives). If it was PostHog: the test claims something about our
Worker but waits on PostHog's speed; a POST answered at all by PostHog (any status, in time) proves the passing on.
