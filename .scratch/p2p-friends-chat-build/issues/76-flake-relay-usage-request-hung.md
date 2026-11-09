# 76 · Flake: the preview's /relay-usage did not answer within 15 s

Status: fixed (worker/relayusage.ts: the call outlives a cancelled request, and no request waits more than 6 s);
fixed means its ledger row stops growing
Type: flake

Seen 2026-11-09: the preview run of #129 at 7a4aff1 (run 42654887559), Chromium, shard 6, passed on its retry.
`settings.spec.ts:370` "About shows the relay this month and the free plan today…": its first step, the test's own
`context.request.get('/relay-usage')` against the preview, timed out after 15 s (`apiRequestContext.get: Timeout 15000ms
exceeded`). No page was involved yet, and #129 changes neither the Worker nor this path. Asked by hand right after, the
same preview answered in about a second, with the live figures.

## Cause
Previews have RELAY_USAGE_API_TOKEN, so /relay-usage asks Cloudflare's GraphQL API (worker/relayusage.ts) unless the
isolate has a kept answer, and a request that comes while another is asking waits for that one's call.

Workers Logs of dave-pr-129 (the observability API, filtered on the path) show it, both at LAX:

| start (UTC)  | outcome  | wall time |
|--------------|----------|-----------|
| 16:29:02.802 | canceled | 1152 ms   |
| 16:29:03.968 | canceled | 14876 ms  |

The first, a page's request, was given up by its browser while its call to the API was under way (they take 0.2 to 1.5
s there). On Cloudflare that cancels the call with it, and the call then neither answers nor fails for anyone waiting
on it. The second, the test's, came 1.2 s later, waited on that call, and was canceled when its client gave up at 15 s
(16:29:18.8, the failure). ASKING_MS let a request coming more than 6 s later ask anew, but not one already waiting.
Every page of every test asks /relay-usage as the app opens, and tests close pages quickly, so a preview run makes
such cancels often; a friend closing the tab right after opening it does the same on the live site.

Not reproducible locally: workerd under `wrangler dev` lets a call of a request whose client went away finish, and
gives it to whoever waits (tried 2026-11-09 with a scratch Worker and a slow upstream).

## Fix
The call a request starts is handed to its `ctx.waitUntil`, which Cloudflare documents as keeping the work going after
the client goes away, so the requests waiting for it get its answer. Not seen on Cloudflare yet: the Workers Logs of a
preview run would show it, as no request at /relay-usage waiting near the 15 s mark again.

And whatever Cloudflare does, every request waits for the figures at most WAIT_MS (6 s) from when it came, then answers
that they are not known (a 200 the dialog shows as such), never an older figure as today's; the next request after the
call is ASKING_MS old asks anew, as before. A call kept alive past a newer one does not replace its answer. `test/relayusage.test.ts` "ticket 76" models the cancelled call as one that never settles.
