# 07 · Night shift: problem reports become failing tests overnight

Status: shipped 2026-10-08 to master (e925593, PR #26), 2026-10-09 to prod; first run the night of 2026-10-09
Type: task

## Why
Problem reports are the best bug intake this app has, and the best fixes started with a red test. Turning a report into a
reproduction is the slow part, and it needs no human.

## What
A scheduled agent (Claude Code routine, daily, early morning) with this repo and a read-only PostHog key:
1. Query new `bug_report`, `$exception`, `share_black` and `invariant_violation` events since the last run (HogQL, see the
   auto memory note on PostHog). Skip test accounts and what `git log origin/master` says is already fixed.
2. Group by likely cause, pick at most two clear ones.
3. For each: write an e2e test that reproduces it, push it alone on a branch `night-shift/<slug>`, and wait for CI. If the
   test fails for the reported reason, open a draft pull request "Repro: …" with the report, the evidence and the red run.
   If it cannot be reproduced, write that up instead (what was tried).
4. Never push to master or prod; never fix. The owner wakes up to reproduced bugs and decides.
A short markdown digest of the night goes into the PR descriptions (or one issue) so the owner sees it from the phone.

## Built
scripts/night-shift/ (run.sh, prompt.md, systemd user timer at 02:30 UTC). Runs on the VM, not as a cloud routine: the reports hold friends' words and the repository is public, so PRs carry paraphrases only. Digests stay in ~/.local/state/night-shift/ and the session briefing points at them.
