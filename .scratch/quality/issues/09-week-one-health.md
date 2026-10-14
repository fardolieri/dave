# 09 · Week one: what failed silently, and the fixes

Status: in progress
Type: task

## What a review of the first week (2026-10-09 to 10-14) found
Worked: the habits held without supervision (every fix a "Regression test:" then "Problem report:" pair, five gated
releases, no bypass), and the flake rule turned about a dozen "flakes" into real app bugs: lost joins, signals refused
after a reconnect, Firefox missing updates, a socket stuck on "Connecting…", ghost presence, texts lost into a dropped
socket. Reviews and the Grumpy Friend stopped a TURN change three times that would have dropped real calls.

Failed silently:
- The night shift died on 10-13 and 10-14 (preflight timed out five times; the CLI's output was thrown away) after the VM
  froze for two days with an expired OAuth token. Nothing told anyone.
- The soak filed four issues for one AudioContext error; none was read in four days.
- The VM froze because four agents ran at once, although the two-agent limit was known (only in one session's memory).
- The gate wrote "failure" for nightly runs that were only superseded, which read as broken commits.
- My own install-retry change (53d4243) went to master without a review and had a bug (apt held the lock); the rule
  "review before master" applies to CI changes too.

## Built
- Video receipts removed (ticket 06).
- Session briefing: last night shift result (or a warning when it did not run), open soak issues, waiting night-shift
  reproductions, the gate on master's head.
- Night shift: every exit records a result line; the preflight logs what the CLI said; a long-lived token from
  `claude setup-token` in `~/.config/night-shift/oauth-token` is used when present (the owner makes it once).
- Soak issues are grouped by a signature (kinds and first line without names or numbers) and count their occurrences.
- The gate writes no verdict for a skipped or cancelled nightly run.
- `CLAUDE.md`: at most two building agents; `scripts/claude/agent-guard.sh` refuses a new agent under 120 MB free.

## Left for the owner
- Run `claude setup-token` on the VM and save the token to `~/.config/night-shift/oauth-token` (chmod 600).
