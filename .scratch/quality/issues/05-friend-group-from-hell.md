# 05 · The friend group from hell: a nightly chaos soak

Status: shipped 2026-10-09 to master (830bd71, PR #34)
Type: task

## Why
The bugs that reach friends are sequences in time (stop then re-share, leave then rejoin, reload mid-call, a background tab).
The e2e suite only covers the sequences someone thought of. A model-based soak covers the ones nobody did.

## What
- A separate Playwright project or spec (`e2e/soak/`, excluded from the normal suite) where 3 or 4 bot friends (Chromium and
  Firefox mixed) share a room and take random actions from a weighted list: join and leave the call, mute and unmute, start,
  stop and re-start a share, watch and stop watching, change share settings, change a friend's volume, send a text, reload,
  hide and show the tab, cut and restore the socket through the wire proxy, go offline for a few seconds.
- After every step, check the model: what everyone should see (roster, who shares, who watches what, mute states, texts),
  and the invariants of ticket 04 (no `invariant_violation`). Waits use the suite's polling helpers with real timeouts.
- Seeded randomness (`fast-check` model-based commands, or a small seeded PRNG): a failure prints the seed and the action
  list, and the run shrinks it to a shorter sequence that still fails. A failing run uploads the trace and opens or updates a
  GitHub issue with the minimal sequence and the seed, labelled `soak`.
- `soak.yml`: nightly cron against nightly (a few shards of 15 to 20 minutes each, different seeds), plus workflow_dispatch
  with a seed and a duration to replay a failure.

## Verify
A dispatch run of 15 minutes that passes, and one with a deliberately broken invariant (a temporary commit on a branch) that
fails, shrinks, and shows the minimal sequence.

## Built
`e2e/soak/` with `playwright.soak.config.ts` (the normal suite ignores it) and `.github/workflows/soak.yml`: nightly at 01:00
UTC against nightly, 3 shards of 15 minutes; four friends (two Chromium, two Firefox) take seeded random actions and every
step is checked against a small model of what everyone should see, plus the invariants. A failure shrinks to a minimal
action list replayed in fresh rooms and opens or updates an issue labelled `soak` (also when it did not come back on
replay: a flake is a bug too). Two runs against nightly, about 1,500 steps, found nothing; a deliberately broken reload
shrank to 5 steps.
