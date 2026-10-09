# Quality program

Status: 01–07 shipped 2026-10-08/09; 08 later
Asked for 2026-10-07/08: Daniel: "Imagine being a tech lead or QA manager who is responsible for the quality of the app. What
would you do? […] Be ambitious! I'm open for WACKY ideas!" and then "Lets do it! The stage is yours."

## What a retrospective of all 17 agent sessions (2026-09-23 to 10-07) found

1. **The dev VM keeps being used as a test lab, and it cannot be one.** Roughly 12 hours went to waiting on it: a two-constant
   change took 1.5 h because vitest fought for memory, the TypeScript 7 bump ran unit tests for 2.5 h without a result,
   filming prototypes took 6 h, local e2e runs timed out or got OOM-killed. Every session rediscovered this.
2. **"Done" meant different things.** Verification was claimed at a higher level than reached: "verify it works" pushed
   without a browser; a fix "verified" on a copy of the component; a modeled preview that picked the wrong splash (7 h lost);
   prod pushed before the nightly e2e finished, which then failed. Nothing in the pipeline stopped prod.
3. **The bugs that reach friends are about time, devices and saved state, not logic.** Stop then re-share, leave then rejoin,
   background then foreground; three times a change to saved settings never reached existing browsers; Android splash,
   wake lock, touch targets. Unit tests cannot see these; e2e only sees the sequences someone thought of.
4. **Independent review found real bugs every time it ran, but it ran after the push.**
5. **Process debris:** push races between parallel sessions, a cherry-pick that diverged prod from master, stale ticket
   state, leftover dev servers holding memory for hours.

What worked and stays: red-then-green regression tests in CI (ticket 21 of the build), the hostile-server Playwright suite,
problem reports with snapshots, the flake policy of ticket 35, fast-forward releases, honest caveats.

## The program

| # | Ticket | Idea |
|---|---|---|
| 01 | Foundation | `CLAUDE.md` with the verification ladder; prod gated on the nightly e2e; session hooks; `/ship` and `/release` |
| 02 | Saved-state guard | CI notices when stored settings change shape or defaults without a migration |
| 03 | Red-then-green receipt | CI proves a regression test fails without its fix |
| 04 | Invariants | the app watches itself: UI that contradicts reality is reported, and fails every e2e test |
| 05 | Friend group from hell | a nightly chaos soak: bots doing random sequences, checked against the invariants, shrunk to a minimal repro |
| 06 | Video receipts | every UI pull request gets recordings at phone and desktop size, filmed in CI |
| 07 | Night shift | a scheduled agent turns new problem reports into failing tests overnight |
| 08 | Canary gate | prod waits until nightly's error rate is no worse than prod's (later: needs nightly traffic) |
