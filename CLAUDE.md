# dave: working agreement for agents

dave is a friends-only chat app: rooms with text, voice and screen share over a peer-to-peer WebRTC mesh, with a Cloudflare
Worker and one Durable Object per room doing only signaling and presence. Start with `README.md` (how to build, test, deploy),
`CONTEXT.md` (the words we use) and `docs/adr/`. Tickets live in `.scratch/` (`docs/agents/issue-tracker.md`).

The owner (Daniel) drives this repo remotely, mostly from a phone, and checks in every few hours. Every report you write is
read on a small screen by someone who did not watch you work: lead with the outcome and the verification level reached.

## Before any work

1. `git checkout master && git pull --ff-only`. The owner pushes from other machines; the clone here is often behind.
2. Work on a branch (`<topic>/<slug>`), never on master directly, unless the owner explicitly says "push straight to master".
3. Another agent session may be running in this repo at the same time (the session-start hook says so). Stay on your branch,
   and fetch before every push: master moves under you.

## The machine: a remote control, not a test lab

The dev box is a 1 GB VM (`~/.claude/CLAUDE.md`). Measured costs from past sessions: vitest takes 30 to 75 min here and often
never finishes, a local e2e build gets workerd OOM-killed, filming a prototype took six hours. **GitHub Actions is the test
environment.** Push a branch and read the results of `ci.yml` and `e2e.yml`.

- OK here: reading code, editing, `git`, `gh`, `pnpm typecheck` (TypeScript 7 is native and fast), one vitest file
  (`pnpm exec vitest run test/x.test.ts`), one e2e test against nightly with `-g` (env vars in the auto memory).
- Not here: the full `pnpm test`, the full e2e suite, `pnpm dev` next to a browser, several heavy commands at once.
- To reproduce a bug: write the failing test, commit it ("Regression test: …"), commit the fix ("Problem report: …"), and
  push both together. `red-green.yml` runs the test against the app from before the fix and must see it fail (the "red,
  then green" receipt); the rest of CI must be green. Do not push the test alone just to watch it go red: every red run
  emails the owner, and these were 38 of the last 100 failed runs.
- Push the test alone first only when `red-green.yml` cannot show the bug: it runs browser tests in Chromium only, against
  a local build, once. A bug that needs Firefox, or real Cloudflare (open a ready, not draft, PR so its preview runs the suite), goes red
  alone first; say why in the report. Same-ref pushes cancel each other, so wait for the red run to finish first.
- Watch CI with one waiting loop, not several background watchers. Under memory pressure `gh` times out on TLS; use
  `curl -H "Authorization: Bearer $(gh auth token)"` against the Actions API instead.
- Leave nothing running at the end of a turn (vite, workerd, chrome, playwright). The stop hook checks this.
- **At most two building subagents at a time**, plus read-only reviewers. On 2026-10-12 four ran at once and the VM froze for
  two days. A hook (`scripts/claude/agent-guard.sh`) refuses a new agent when less than 120 MB of memory is free
  (a read-only reviewer runs inside the session's process and costs little). Prefer one
  branch worked on in sequence over many in parallel: CI's 20 runners are the shared bottleneck anyway.

## Definition of done: the verification ladder

Every change climbs this ladder, and every report says which rung it reached, in these words:

| Rung | Means | Where |
|---|---|---|
| 0 typed | `pnpm typecheck` passes | here or CI |
| 1 unit | `pnpm test` passes | CI (`ci.yml`) |
| 2 browser | the e2e suite passes against a local build, both engines; with an open ready PR, also against its preview | CI (`e2e.yml` on the branch, `preview.yml` on the PR) |
| 3 nightly | deployed to nightly and the e2e suite passed against it | CI (`e2e.yml` after deploy) |
| 4 seen | a human or a recording looked at the real thing (real browser, real device for phone features) | owner, or a recording |

Rules:
- **Say what you did not verify.** "Verified: rung 2. Not verified: on a phone." is a good report. A check on a copy, a
  mock, a modeled timeline or a test page is not the real thing: name it as what it is.
- **"Verify it works" from the owner means rung 2 at least, and rung 4 for anything visual.**
- **Bug fixes start red.** A problem report gets a regression test that fails without the fix (in CI) before the fix lands.
  Commit the test first ("Regression test: …"), then the fix ("Problem report: …"). The `red-green` job (`red-green.yml`)
  checks this on every branch: it runs the tests of those two commits against the app from before the branch and fails a
  "Problem report:" commit with no test that fails there, unless the commit's body has a line "No regression test: <reason>"
  (for bugs no test can reach). Put any hook or helper the test needs (`src/client/hooks.ts`, `e2e/fixtures.ts`) in the
  "Regression test:" commit, so the test fails on the bug and not on a missing hook: the job calls that inconclusive.
- **Review before the first push to master**, not after: an independent review subagent (or `/code-review`) on the diff.
  Past reviews found real bugs every time they ran. Then review the fixes again, until a round finds nothing real, at most
  three rounds (`/ship` step 2 says how).
- **Saved state needs a migration story.** Anything in `localStorage` or IndexedDB outlives a deploy: changing a default or a
  stored shape does not reach existing browsers by itself. Either migrate, or say plainly in the report who will not see it.
  Every stored key is listed in `src/core/storedstate.ts` with its parser and fixtures. `test/storedstate.test.ts` fails on
  a changed default or shape and says what to do.
- Never invent commit hashes, test counts or CI results. Copy them from the output.

## Shipping

- `master` deploys nightly (`dave-nightly`); `prod` deploys the live site. Releasing is a fast-forward:
  `git push origin master:prod`, nothing else (no cherry-picks, no force pushes).
- **prod is gated:** GitHub refuses a push to prod unless the commit has the `nightly e2e passed` status, which `e2e.yml`
  writes only after the full suite passed against nightly for exactly that commit. So: push master, wait for deploy and
  nightly e2e, then release. `/release` does this.
- `/ship` takes a branch from "works" to "on master": rebase, review, push, CI, report.
- Prefer small PRs. Squash noise (debug commits, CI experiments) into a coherent story before master.

## What watches the app

- **CI on every branch:** typecheck and unit tests in both Wrangler envs (`ci.yml`), the browser suite in both engines
  (`e2e.yml`), the red-then-green check of regression tests (`red-green.yml`). Not while the branch's PR is a draft
  (`draft-gate.yml`): a draft is still being iterated on, and its pushes end green with the jobs skipped, which is no
  verdict. Marking it ready runs all three on its head. `night-shift/*` branches always run them.
- **On every open PR**, drafts too: a preview Worker of its own, `dave-pr-<n>` (`preview.yml`), built like nightly, with
  the whole e2e suite run against it once deployed (once ready, not while a draft). One comment on the PR links it and a
  room of the PR's own, so the owner can try a change from the phone before it reaches master. It starts with empty
  storage: a change that meets old saved state is only really seen on nightly. The night shift's drafts get none. A weekly
  sweep (`preview-sweep.yml`) deletes previews whose PR closed.
- **Inside every e2e test:** unexpected console warnings and runtime invariants (`src/client/invariants.ts`: UI that
  contradicts the call) fail the test.
- **Nightly:** the suite against nightly is the release gate; the chaos soak (`soak.yml`, 01:00 UTC) opens `soak` issues
  with a minimal sequence; the night shift (`scripts/night-shift/`, on this VM, 02:30 UTC) turns new problem reports into
  draft "Repro:" PRs.
- **Every session's briefing** (`scripts/claude/session-start.sh`) says how the unattended parts did: the night shift's last
  run, open soak issues, waiting reproductions, the gate on master. A warning there comes before new work.
- **In the field:** `invariant_violation`, `$exception` and `bug_report` in PostHog (read recipe in the auto memory).

## Flakes

A flaky test is a bug in the app or in the test, never noise (`.scratch/p2p-friends-chat-build/issues/35-*`): find the cause,
then fix the app, fix the test, or drop the claim. A longer timeout or another retry does not count unless the cause is known.

## Code

- Match the surrounding style: comment density, naming, the plain prose of the existing comments and commit messages.
- `src/core/` is runtime-neutral and unit-tested; keep DOM and SDK code in `src/client/` (enforced by
  `scripts/check-core-isolation.mjs`).
- Commit messages: a sentence-case subject that says what is true now ("Muting a friend's share no longer mutes the friend"),
  a body explaining why when it is not obvious.
