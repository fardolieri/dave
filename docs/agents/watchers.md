# What watches the app

What runs with nobody watching, and what each one tells you. `AGENTS.md` points here: read it when a warning in the
session briefing, a `quota` or `soak` issue, a preview, a nightly result or field data is part of the task.

- **CI on every branch:** typecheck and unit tests (`ci.yml`), the red-then-green check of regression tests
  (`red-green.yml`). Not while the branch's PR is a draft (`draft-gate.yml`): a draft is still being iterated on, and its
  pushes end green with the jobs skipped, which is no verdict. Marking it ready runs both on its head. `night-shift/*`
  branches always run them, and the browser suite against a local build too (`e2e.yml`): their drafts get no preview.
  Other branches get the browser suite from their PR's gate only (below); a run against a local build is by hand.
- **On every open PR**, drafts too: a preview Worker of its own, `dave-pr-<n>` (`preview.yml`), the live build plus the
  inspection hooks, deployed on every push. The gate to master, started by hand (`AGENTS.md`, Testing): the whole e2e suite
  against the preview, and the tests a deployed copy cannot run (tagged `@local`: a deploy or an outage staged at the
  preview server) against a local build of the PR; or, with the previews' share of the day used up, the whole suite
  against a local build. One comment on the PR links it and a room of the PR's own, so the owner can try a
  change from the phone before it goes live. It starts with empty storage. The night shift's drafts get none. A nightly
  sweep (`preview-sweep.yml`) deletes previews whose PR closed, once the day it closed on has ended.
- **Inside every e2e test:** unexpected console warnings and runtime invariants (`src/client/invariants.ts`: UI that
  contradicts the call) fail the test.
- **Every night:** the chaos soak (`soak.yml`, 01:00 UTC, a local build of master) opens `soak` issues with a minimal
  sequence; the night shift (`scripts/night-shift/`, on the dev box, 02:30 UTC) turns new problem reports into
  draft "Repro:" PRs.
- **Every quarter of an hour:** the Workers Free plan's daily limits (`quota-watch.yml`, asked of Cloudflare itself). At
  70 % and at 90 % of the live site's or the previews' share of one, each once a day: an issue labelled `quota` and a
  red run, which mails the owner. Past a limit every Durable Object of the account fails until midnight UTC, the
  previews' with the live site's. The live site lets no new socket into a room once it has used 25 % of any daily limit
  (`FREE_PLAN_SHARES`, `wrangler.jsonc`), and tells the friends when the rooms are back; the previews, together, stop at
  65 %, so neither can use up the other's share (`SIDE_SHARES`, `src/core/relayusage.ts`). A preview Worker is kept
  until the day its PR closed has ended: deleted, its rooms' use leaves Cloudflare's analytics while Cloudflare still
  counts it against the day (`preview-sweep.yml`).
- **Every session's briefing** (`scripts/claude/session-start.sh`) says how the unattended parts did: the night shift's last
  run, open soak and `quota` issues, waiting reproductions, whether master's head reached the live site.
- **In the field:** `invariant_violation`, `$exception` and `bug_report` in PostHog (read recipe in the auto memory).
