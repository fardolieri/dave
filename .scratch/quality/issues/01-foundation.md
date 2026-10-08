# 01 · Foundation: one definition of done, a gated prod, sessions that know the machine

Status: in progress
Type: task

## Goal
Every session starts with the same rules, and the pipeline enforces the one that matters most: prod only gets commits that
passed the full browser suite against nightly.

## Built
- `CLAUDE.md` (and `AGENTS.md`, a link to it): the machine is a remote control and CI the test lab; the verification ladder
  (typed, unit, browser, nightly, seen) that every report names; bug fixes start red; review before master; saved state
  needs a migration story; shipping and flake rules.
- `.claude/settings.json` hooks: `scripts/claude/session-start.sh` briefs each session (behind master, unreleased commits,
  free memory, other sessions, leftover processes); `scripts/claude/stop-check.sh` sends the agent back once if a dev server,
  workerd or a browser is still running when it wants to stop.
- `.claude/skills/ship`: rebase, review plus the adversarial "Grumpy Friend" subagent, push, CI, nightly, report the rung.
- `.claude/skills/release`: check the gate, fast-forward prod, watch the deploy, report.
- `ci.yml` tests both Wrangler environments the deploys use (prod's and nightly's).
- `e2e.yml` ends with a `gate` job. In the run after a master deploy it is called `nightly e2e passed` and succeeds only if
  every shard passed; on branches it is called `e2e passed`, so a branch run of the same commit cannot satisfy the gate.
- `playwright.config.ts`: `failOnFlakyTests` against a deployed copy in CI, so the gate run has no flakes.
- A ruleset on `prod` (set up through the GitHub API once this is on master): required check `nightly e2e passed` from
  GitHub Actions, no force pushes, no deletion. A ruleset on `master`: no force pushes, no deletion.

## Verify
- A branch push shows `check (prod)`, `check (nightly)` and `e2e passed`.
- After the merge, the nightly e2e run of the master commit shows `nightly e2e passed`, and `git push origin master:prod`
  works; for a commit without it, GitHub refuses the push.
