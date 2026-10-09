# 06 · Video receipts: every UI change filmed in CI, viewable on the phone

Status: shipped 2026-10-08 to master (814d5f4, PR #23), 2026-10-09 to prod
Type: task

## Why
Visual work was checked on a modeled preview (the logo splash, 7 hours lost), or filmed on the VM (6 hours for a handful of
clips). GitHub's runners film the same in minutes. The owner reviews from a phone: the receipt should be one tap away in the
pull request.

## What
- A `receipts` job on pull requests that touch `src/client/` (and by hand): a Playwright "tour" spec
  (`e2e/receipts/`, excluded from the normal suite) that opens two or three friends and walks the main screens, recording
  video at a phone viewport and a desktop viewport. A pull request can add its own steps (a `receipts.ts` beside the tour,
  or tests tagged `@receipt`) to film the feature it changes.
- Convert the videos to small looping GIFs or MP4s with ffmpeg and publish them where a PR comment can show them inline:
  commit them to an orphan `receipts` branch under `pr-<n>/<sha>/` and post or update one PR comment that embeds them via
  raw.githubusercontent URLs, with before (master) and after (branch) side by side when cheap.
- Clean up: delete a PR's folder from the `receipts` branch when it is closed.
- Optionally (if it stays free): a per-PR preview Worker (`dave-pr-<n>`, deleted on close) so the owner can tap through the
  real thing on the phone. Check first that Durable Objects allow it on the free plan and do not touch the prod or nightly
  Workers.

## Verify
A PR with a small visible change shows a comment with the phone and desktop recordings, before and after.

## Built
.github/workflows/receipts.yml films e2e/receipts/tour.spec.ts plus any test tagged @receipt at phone and desktop size, master's build next to the PR's, as GIFs (under 3 MB, inline on a phone) on the orphan `receipts` branch, and keeps one PR comment up to date. Per-PR preview Workers were researched and left out: Workers with Durable Objects get no preview URLs, and a separate Worker would share prod's free-plan quotas.
