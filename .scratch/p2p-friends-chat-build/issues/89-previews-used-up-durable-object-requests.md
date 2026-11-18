# 89 · No room let anyone in: the previews' runs used up the day's requests to Durable Objects, unseen

Status: fix in review (PR "The live site and the previews each get their own share of every daily limit…")
Type: bug, outage (reported by the owner, 2026-11-17 ~20:50 UTC, with Cloudflare's mail "Service requests are
temporarily blocked")

## The outage
From 20:44:21 UTC on 2026-11-17 until the block lifted after midnight, every socket to a room was refused with a 500,
the live site's and every preview's: "Exceeded allowed volume of requests in Durable Objects free tier." (the Worker's
`server_upgrade_failed` in PostHog, 5,648 from previews and 318 from the live site by 20:50). The Workers Free plan
allows 100,000 requests to Durable Objects a day, the whole account's.

## What used them
The previews' browser suites (preview.yml, e2e.yml), several full runs in the day and three at once around 20:00 UTC
(#158, #159, #160: about 15,000 to 18,000 requests to Durable Objects each in that hour, as a parallel session read
them, frames to hibernating rooms counted whole). The live site's rooms: about 13,000 all day, most of them the sweep's
alarm, once a minute in every room with a socket (`room.ts`, `SWEEP_INTERVAL_MS`).

## Why nobody saw it coming
1. **The count missed the previews deleted that day.** A preview Worker was deleted when its PR closed (preview.yml), and
   with it its Durable Object namespaces, whose rows leave Cloudflare's analytics, the day's included. Cloudflare still
   counts what they used against the day. At 20:46 `/relay-usage` said 34,655 requests of 100,000; an hour later, more
   previews deleted, 27,253. The previews of #148, #150, #151, #153, #154 and #155 had run their suites that day and are
   in no figure. Their Worker requests stay (as `__unknown__`), so `Worker requests` was right.
2. **quota-watch ran twice that day** (09:00 and 18:25 UTC): GitHub dropped its quarter-hour runs. With the count missing
   the deleted previews, a 40 % warning would not have fired anyway.
3. **Our own limit was on Durable Object time only** (`OWN_COMPUTE_LIMIT`, ticket 84), and on the live site only.

Whether Cloudflare counts a frame to a hibernating room as a twentieth of a request (its billing, which the dialog
follows) or as a whole one against the free plan's daily limit is not settled: its pricing page applies 20:1 "for
compute requests billing-only". The figures of 2026-11-17 cannot tell, with the deleted previews' rows gone. The next
day the account runs out, with every preview kept, the dialog's figure at the time of the block says which.

## The fix
- A preview Worker is kept until the day (UTC) its PR closed on has ended; preview-sweep.yml deletes it after midnight,
  every night. Its rooms' use stays in the analytics for the day it counts against.
- The live site and the previews each get 45 % of every daily limit (`SIDE_SHARE`, core/relayusage.ts; `FREE_PLAN_SHARES`,
  wrangler.jsonc): the tenth between is for the minutes Cloudflare's figures lag, so each side keeps its half. The live
  site counts its own Worker (by name) and its Durable Object namespaces (by id, `LIVE_NAMESPACES`); the previews all
  the rest. Past its share of any daily limit a side's Worker closes new sockets with 4007, as our own limit did. The
  server's history takes its daily caps from a side's share (core/kept.ts). The About dialog shows each side's part
  under every daily figure; quota-watch tells at 70 % and 90 % of each side's share, each side its own issue.
- Regression test: `test/shares.test.ts` (a preview's Worker let sockets in, whatever the previews had used).

## What the shares leave the previews
A run of the browser suite against a preview (both engines) took some 10,000 to 13,000 requests to the Worker and some
7,000 to Durable Objects (frames counted 20 to 1) on 2026-11-17: the previews' 45,000 Worker requests are what runs out
first, after three or four runs a day, all PRs together. quota-watch tells at 70 % of it.

## Not done
- Fewer requests per preview run, and fewer alarms in rooms with one friend in them (the sweep matters only with two):
  the next levers, not part of this fix.
- GitHub's dropped scheduled runs: quota-watch still relies on them.

## Comments

2026-11-18, the morning after: the previews' share (45 %) was used up by 01:20 UTC, 6 to 7 suite runs (#159 pushed three
times in 20 minutes, #162 two runs and two re-runs, #161 one); the live site used 1 % of its own. A run measured on #161:
some 7,000 requests to Durable Objects (the history's syncs 42 %, sockets 32 %, the sweep's alarm 17 %, frames to
sleeping rooms 9 %), 3,200 to the Worker, 4,300 rows written, 10,900 read, 280 GB-s. On the owner's word:
- The shares are now 25 % for the live site (twice its busiest day) and 65 % for the previews (`SIDE_SHARES`).
- The browser suite no longer runs on every push to a ready PR: it is the gate, started once a PR is meant to land
  (`gh workflow run preview.yml --ref <branch> -f pr=<n>`). With no room left in the previews' share for a run (`RUN_COST`,
  `scripts/gate-mode.mjs`), it runs against a local build of the PR on GitHub's runners and writes the gate's status all
  the same, saying so: a PR no longer waits for midnight.
- quota-watch ran once between 18:25 on 2026-11-17 and 07:45 the next day: GitHub drops most of its quarter-hour runs.
  Not fixed here.
