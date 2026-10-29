#!/usr/bin/env bash
# SessionStart hook (.claude/settings.json): a short briefing that lands in the agent's context, so every session starts
# knowing where master is, how much memory is left, and who else is working here. Never fails the session.
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" 2>/dev/null || exit 0

timeout 10 git fetch -q origin master 2>/dev/null
branch=$(git branch --show-current 2>/dev/null)
behind=$(git rev-list --count HEAD..origin/master 2>/dev/null)
dirty=$(git status --porcelain 2>/dev/null | wc -l)
avail=$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}')
# Not the shell that launched a session: T3's wrapper (sh -c ... systemd-run ... claude) carries the same words.
others=$(( $(pgrep -af '[c]laude --output-format' 2>/dev/null | grep -cvE '^[0-9]+ (/usr)?(/bin/)?(ba)?sh ') - 1 ))
heavy=$(pgrep -fa '[w]orkerd|[v]ite (dev|preview)|[c]hrome-linux|[h]eadless_shell|[p]laywright test' 2>/dev/null | grep -Ev '^[0-9]+ (/bin/)?(ba)?sh |claude' | cut -c1-100)

echo "Session briefing (scripts/claude/session-start.sh):"
echo "- On branch '${branch:-detached}', ${behind:-?} commit(s) behind origin/master, ${dirty} changed file(s)."
[ "${behind:-0}" != 0 ] && [ "$branch" = master ] && echo "  -> run 'git pull --ff-only' before starting work."
echo "- ${avail:-?} MB memory available. What this machine can run: ~/.claude/CLAUDE.md. CI is the receipt."
[ "$others" -gt 0 ] 2>/dev/null && echo "- WARNING: $others other agent session(s) running on this machine. Work on your own branch, fetch before pushing, and do not run heavy commands at the same time."
[ -n "$heavy" ] && { echo "- Leftover heavy processes from earlier sessions (kill them unless another session owns them):"; echo "$heavy" | sed 's/^/    /'; }
# Health of the machinery that runs without anyone watching. Each of these once failed for days unnoticed: the night shift
# (dead 2026-10-13 and 14), soak issues (four for one error, none read), the gate on master, now the deploy of master.
state=${XDG_STATE_HOME:-$HOME/.local/state}/night-shift
if [ -r "$state/last-result" ]; then
  read -r when status reason < "$state/last-result"
  age=$(( ($(date +%s) - $(date -d "$when" +%s 2>/dev/null || echo 0)) / 3600 ))
  if [ "$status" = ok ] && [ "$age" -lt 30 ]; then
    echo "- Night shift ran ${age} h ago: $state/$reason (draft 'Repro:' PRs: gh pr list --draft --search 'head:night-shift/')."
  elif [ "$age" -ge 30 ]; then
    echo "- WARNING: the night shift has not run for ${age} h (last: $status $reason). Check: systemctl --user list-timers; $state/logs/."
  else
    echo "- WARNING: the night shift's last run $status ${age} h ago: $reason. Log: $state/logs/."
  fi
fi
token=$(timeout 3 gh auth token 2>/dev/null)
if [ -n "$token" ]; then
  # At once and short: the hook has 60 s.
  gh_api() { curl -s -m 5 --connect-timeout 3 -H "Authorization: Bearer $token" "https://api.github.com/repos/fardolieri/dave/$1"; }
  head=$(git rev-parse origin/master 2>/dev/null)
  tmp=$(mktemp -d)
  gh_api "issues?labels=soak&state=open&per_page=50" > "$tmp/soak" & gh_api "pulls?state=open&per_page=50" > "$tmp/pulls" &
  gh_api "actions/workflows/deploy.yml/runs?head_sha=$head&per_page=1" > "$tmp/deploy" &
  gh_api "actions/workflows/rollback.yml/runs?status=success&per_page=1" > "$tmp/rollback" & gh_api "contents/top.txt?ref=flake-ledger" > "$tmp/flakes" & wait
  soak=$(jq -r 'if type == "array" then [.[] | "#\(.number) \(.title[0:90])"] | join("\n") else empty end' "$tmp/soak" 2>/dev/null)
  [ -n "$soak" ] && { echo "- Open soak issues (the nightly chaos soak found these; triage before new work):"; echo "$soak" | sed 's/^/    /'; }
  repro=$(jq -r 'if type == "array" then [.[] | select(.head.ref | startswith("night-shift/")) | "#\(.number) \(.title[0:90])"] | join("\n") else empty end' "$tmp/pulls" 2>/dev/null)
  [ -n "$repro" ] && { echo "- Night shift reproductions waiting:"; echo "$repro" | sed 's/^/    /'; }
  deploy=$(jq -r '.workflow_runs[0]? // empty | if .status == "completed" then .conclusion else .status end' "$tmp/deploy" 2>/dev/null)
  deployed_at=$(jq -r '.workflow_runs[0]?.updated_at // empty' "$tmp/deploy" 2>/dev/null)
  rolled_back_at=$(jq -r '.workflow_runs[0]?.updated_at // empty' "$tmp/rollback" 2>/dev/null)
  # ISO timestamps compare as strings. A rollback after the deploy means the site runs an older version than master.
  [ "$deploy" = success ] && [ -n "$rolled_back_at" ] && [[ "$rolled_back_at" > "$deployed_at" ]] && deploy=rolled-back
  flakes=$(jq -r '.content // empty' "$tmp/flakes" 2>/dev/null | base64 -d 2>/dev/null)
  [ -n "$flakes" ] && { echo "- Flakes seen most this week (the flake ledger: README.md on branch flake-ledger):"; echo "$flakes" | sed 's/^/    /'; }
  rm -rf "$tmp"
  case "$deploy" in
    success) echo "- master's head ${head:0:7} is on the live site (deploy.yml)." ;;
    rolled-back) echo "- WARNING: the live site was rolled back (rollback.yml) after master's head ${head:0:7} deployed: it runs an older version until a fix lands." ;;
    failure|cancelled|timed_out) echo "- WARNING: the deploy of master's head ${head:0:7} ended $deploy: the live site runs an older commit. Read the run before new work." ;;
    *) echo "- Deploy of master's head ${head:0:7}: ${deploy:-unknown}." ;;
  esac
fi
# Texts a friend's app refused (ADR 0005): a server that tampers, or an app that seals wrong. Urgent either way, so it is
# asked of PostHog here and not left to a dashboard nobody opens. The live site, the last 7 days, test browsers left out.
key=$(cat "$HOME/.config/posthog/key" 2>/dev/null)
if [ -n "$key" ]; then
  q="SELECT toString(properties.reason), count() FROM events WHERE event = 'text_rejected' AND timestamp > now() - INTERVAL 7 DAY AND (properties.is_test_account IS NULL OR properties.is_test_account != true) AND coalesce(properties.build_target, 'live') = 'live' GROUP BY toString(properties.reason)"
  rejected=$(curl -s -m 8 --connect-timeout 3 -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg q "$q" '{query: {kind: "HogQLQuery", query: $q}}')" https://eu.posthog.com/api/projects/267836/query/ \
    | jq -r 'if (.results | type) != "array" then "?" elif (.results | length) == 0 then "none" else [.results[] | "\(.[1]) \(.[0])"] | join(", ") end' 2>/dev/null)
  rejected=${rejected:-?} # no answer at all (a timeout) is not "none"
  if [ "$rejected" = none ]; then :
  elif [ "$rejected" = "?" ]; then echo "- Could not ask PostHog for refused texts (text_rejected)."
  else echo "- WARNING: friends' apps refused texts in the last 7 days ($rejected): a server that tampers, or a client that seals wrong (ADR 0005). Look at the text_rejected events in PostHog before new work."
  fi
fi
exit 0
