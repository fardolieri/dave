#!/usr/bin/env bash
# SessionStart hook (.claude/settings.json): a short briefing that lands in the agent's context, so every session starts
# knowing where master is, how much memory is left, and who else is working here. Never fails the session.
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" 2>/dev/null || exit 0

timeout 20 git fetch -q origin master prod 2>/dev/null
branch=$(git branch --show-current 2>/dev/null)
behind=$(git rev-list --count HEAD..origin/master 2>/dev/null)
dirty=$(git status --porcelain 2>/dev/null | wc -l)
avail=$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}')
unreleased=$(git rev-list --count origin/prod..origin/master 2>/dev/null)
others=$(( $(pgrep -c -f '[c]laude --output-format' 2>/dev/null || echo 0) - 1 ))
heavy=$(pgrep -fa '[w]orkerd|[v]ite (dev|preview)|[c]hrome-linux|[h]eadless_shell|[p]laywright test' 2>/dev/null | grep -Ev '^[0-9]+ (/bin/)?(ba)?sh |claude' | cut -c1-100)

echo "Session briefing (scripts/claude/session-start.sh):"
echo "- On branch '${branch:-detached}', ${behind:-?} commit(s) behind origin/master, ${dirty} changed file(s)."
[ "${behind:-0}" != 0 ] && [ "$branch" = master ] && echo "  -> run 'git pull --ff-only' before starting work."
echo "- master is ${unreleased:-?} commit(s) ahead of prod (unreleased)."
echo "- ${avail:-?} MB memory available. GitHub Actions is the test environment; see CLAUDE.md before running anything heavy."
[ "$others" -gt 0 ] 2>/dev/null && echo "- WARNING: $others other agent session(s) running on this machine. Work on your own branch, fetch before pushing, and do not run heavy commands at the same time."
[ -n "$heavy" ] && { echo "- Leftover heavy processes from earlier sessions (kill them unless another session owns them):"; echo "$heavy" | sed 's/^/    /'; }
night=$(ls -t "${XDG_STATE_HOME:-$HOME/.local/state}"/night-shift/digest-*.md 2>/dev/null | head -1)
[ -n "$night" ] && [ -n "$(find "$night" -mmin -1440 2>/dev/null)" ] && echo "- The night shift left a digest: $night (draft 'Repro:' PRs: gh pr list --draft --search 'head:night-shift/')."
exit 0
