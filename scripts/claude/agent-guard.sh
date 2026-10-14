#!/usr/bin/env bash
# PreToolUse hook on Agent (.claude/settings.json): no new subagent when the machine is short of memory. On 2026-10-12 four
# agents ran at once here and the VM froze for two days (the night shift died with it). Exit 2 refuses the call and tells
# the agent why; it can wait for a running agent to finish and try again.
avail=$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}')
[ -z "$avail" ] && exit 0
if [ "$avail" -lt 120 ]; then
  echo "Not starting another agent: only ${avail} MB of memory available (needs 120). Wait for a running agent to finish, then try again. At most two building agents at a time on this VM (CLAUDE.md)." >&2
  exit 2
fi
exit 0
