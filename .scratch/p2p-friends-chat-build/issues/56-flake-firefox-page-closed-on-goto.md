# 56 · Flake: Firefox's page was closed under the first page.goto of a call test

Status: open, cause not known
Seen 2026-10-15: the preview run of PR #64 (38778973142, head fad7c40, against `dave-pr-64`), Firefox, shard 1, passed
on the retry: `call.spec.ts:16` "a mesh of three: every pair connects, a visitor sees the call without being in it"
failed after 2.9 s with `page.goto: Target page, context or browser has been closed`.

## What is known
- It failed while opening a friend's page, before the app did anything: the browser or its context went away, not an
  assertion about the app.
- The same day, the preview runs of design/all-themes failed twice (12:09 and 12:18 UTC); not read yet whether for this.

## Next
- Read the job's trace and the Firefox stderr in the artifacts for a crash or an out-of-memory kill of the runner.
- Count how often `page.goto` fails like this across e2e and preview runs of the last week.
