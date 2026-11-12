#!/usr/bin/env bash
# Stop hook (.claude/settings.json): a turn may not end with a dev server, workerd or a browser still running. They hold
# memory for hours after the agent has forgotten them. Exit 2 sends the agent back to clean up, once. Only this session's
# count, and leftovers no session runs any more (heavy.sh): another session's test run is its own business.
input=$(cat)
case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac

heavy=$("$(dirname "$0")/heavy.sh")
mine=$(awk -F'\t' '$1 == "mine" { print $2 }' <<< "$heavy" | cut -c1-120)
left=$(awk -F'\t' '$1 == "orphan" { print $2 }' <<< "$heavy" | cut -c1-120)
[ -z "$mine$left" ] && exit 0
{
  [ -n "$mine" ] && { echo "This session's heavy processes are still running: stop them before ending the turn"; echo "(kill by PID, or pkill with a [b]racketed pattern so it cannot match your own shell)."; echo "$mine"; }
  [ -n "$left" ] && { echo "Leftovers no running agent session owns: stop them too, unless they are not yours to stop (the owner's, or"; echo "T3's own); then say so and end."; echo "$left"; }
} >&2
exit 2
