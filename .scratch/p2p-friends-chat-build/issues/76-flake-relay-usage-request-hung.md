# 76 · Flake: the preview's /relay-usage did not answer within 15 s

Status: open; the cause is not known yet
Type: flake

Seen 2026-11-09: the preview run of #129 at 7a4aff1 (run 42654887559), Chromium, shard 6, passed on its retry.
`settings.spec.ts:370` "About shows the relay this month and the free plan today…": its first step, the test's own
`context.request.get('/relay-usage')` against the preview, timed out after 15 s (`apiRequestContext.get: Timeout 15000ms
exceeded`). No page was involved yet, and #129 changes neither the Worker nor this path. Asked by hand right after, the
same preview answered in about a second, with the live figures.

## What is known
Previews have RELAY_USAGE_API_TOKEN, so this request asks Cloudflare's GraphQL API (worker/relayusage.ts) unless the
isolate has a kept answer. Each call to the API has a 5 s timeout, so one request should end within some 5 s.

## Suspect (unproven)
A request that comes while another's call is under way waits for that call (`await asking.done` in `keptFigure`), with
no limit of its own. ASKING_MS lets a later request ask anew when a call runs past 6 s, but whoever is already waiting
keeps waiting: if the call never ends (the comment there allows for it), neither does their request. Every page of
every test asks /relay-usage as the app opens, so a preview run makes many such requests at once.

## Next
Read the trace of the failed try (artifact `e2e-chromium-6-42654887559-1`) for the timing, and check whether a fetch
with `AbortSignal.timeout` in a Worker can outlive its signal (the body read included). If so, bound the wait as well.
