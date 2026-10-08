---
name: ship
description: Take the current branch from "it works" to "on master and nightly-verified" in this repo — rebase, independent review plus an adversarial "Grumpy Friend" pass, push, wait for CI and the nightly e2e run, and report the verification rung reached. Use when the owner says ship it, push it to master, land it, or similar.
---

# /ship

The path every change takes to master. It turns the habits that caught real bugs in past sessions (review before push,
red-then-green, CI as the test lab) into one routine. Read `CLAUDE.md` first if you have not this session.

Arguments: optional `--no-review` (the owner explicitly waived review), `--release` (continue with `/release` at the end).

## 1. Get the branch ready

1. `git fetch origin`. You must be on a topic branch with commits ahead of `origin/master`. If you are on master with local
   commits, create a branch from them first.
2. Rebase onto `origin/master`. Squash noise (debug commits, CI experiments, "fix typo") into a coherent story: one commit
   per idea, each with a subject that states what is true now. Keep a `Regression test: …` commit separate and before its
   fix.
3. Grep the diff for leftovers: `git diff origin/master... | grep -nE "console\.log|debugger|test\.only|\.only\(|DEBUG|zz-"`.
4. `pnpm typecheck` (fast here). Do not run the full unit or e2e suites on this machine.

## 2. Review before anything reaches master

Unless `--no-review`, spawn two subagents **in parallel**, both read-only, both given the diff range
(`git diff origin/master...HEAD`) and told not to build or run tests on this 1 GB machine:

- **Reviewer**: a correctness review of the diff (the `/code-review` skill at medium effort is fine). Bugs, races, missing
  cleanup, saved state that outlives the deploy without a migration (`localStorage`, IndexedDB), UI states that can stick.
- **Grumpy Friend**: an adversarial persona. "You are a friend of Daniel's who uses dave every evening on a cheap Android
  phone, in a Firefox tab, with flaky Wi-Fi, and you love finding ways to break things. Read this change. Describe the three
  nastiest realistic sequences that would break it (timing, leave/rejoin, reload mid-action, background tab, a second
  device, an old browser with old saved settings). For each one, say whether an existing test in `e2e/` or `test/` covers
  it; if not, write the Playwright test (using `e2e/fixtures.ts`'s `crowd`) that would catch it." It returns tests as text.

Then:
- Fix real findings. Add the Grumpy Friend tests that cover something new (to `e2e/`, matching the existing style), and drop
  the ones that duplicate coverage. Say which you dropped and why.
- If a finding is a judgment call (complexity against a rare race, say), do not decide alone: list it for the owner.

## 3. Push and let CI judge

1. Push the branch (`git push -u origin HEAD`). If a PR exists or the owner works with PRs, open or update it and link it
   in the thread (`link_pull_request` when the t3-code MCP server is up).
2. Wait for both `ci` and `e2e` on the branch head: **one** loop polling the Actions API (see `CLAUDE.md` for the curl form
   when `gh` times out), checking every 60 s, about 15 min at most. Never several watchers.
3. If red, read the failing job's log (`curl -L` on `/actions/jobs/<id>/logs`), fix, and push again. A test that failed and
   then passed on retry is a flake to explain, not a pass: check the report for `flaky`.
4. When green: `git push origin HEAD:master` (a fast-forward; if master moved, rebase, rerun typecheck, push the branch
   again, and wait for CI again only if the incoming commits touched `src/`, `e2e/` or `test/`).

## 4. Nightly

Wait for `deploy` on the master commit, then for the `e2e` run it triggers against nightly and its `nightly e2e passed`
commit status. That status is what makes the commit releasable (`/release`).

## 5. Report

Lead with the outcome. Then:

```
Verified: rung 3 (nightly e2e passed for <sha>). Not verified: <phone / real device / whatever is true>.
Review: <n> findings, <fixed / left for you: …>. Grumpy Friend: <n> tests added (<names>), <n> dropped as covered.
Saved state: <none touched | migrated | not migrated: who will not see it>.
```

Then delete the merged branch (local and remote) unless the owner wants it kept. With `--release`, continue with `/release`.
