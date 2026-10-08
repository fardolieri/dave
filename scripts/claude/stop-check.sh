#!/usr/bin/env bash
# Stop hook (.claude/settings.json): a turn may not end with a dev server, workerd or a browser still running. On a 1 GB
# machine they hold memory for hours after the agent has forgotten them. Exit 2 sends the agent back to clean up, once.
input=$(cat)
case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac

heavy=$(pgrep -fa '[w]orkerd|[v]ite (dev|preview)|[c]hrome-linux|[h]eadless_shell|[p]laywright test' 2>/dev/null | grep -Ev '^[0-9]+ (/bin/)?(ba)?sh |claude' | cut -c1-120)
[ -z "$heavy" ] && exit 0
{
  echo "These heavy processes are still running. Stop the ones this session started before ending the turn"
  echo "(kill by PID, or pkill with a [b]racketed pattern so it cannot match your own shell). If another session owns them, say so and end."
  echo "$heavy"
} >&2
exit 2
