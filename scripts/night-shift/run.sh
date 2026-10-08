#!/usr/bin/env bash
# The night shift (.scratch/quality/issues/07-night-shift.md): once a night, an agent turns new problem reports into failing
# e2e tests on branches `night-shift/*` and opens draft "Repro:" pull requests for the owner. It runs here and not as a cloud
# routine because the reports hold friends' words and the PostHog key lives only on this machine; nothing private goes to
# GitHub except what the agent paraphrases. The heavy part (running the tests) happens in GitHub Actions.
#
# Started by a systemd user timer (night-shift.timer, installed by ./install.sh, which copies this script out of the repo so
# the timer never depends on what the main checkout has checked out). The prompt is read from master each night.
# Run by hand: systemctl --user start night-shift (logs in ~/.local/state/night-shift/logs).
set -uo pipefail
REPO=${DAVE_REPO:-$HOME/repos/dave}
WT=$HOME/repos/dave-night-shift
STATE=${XDG_STATE_HOME:-$HOME/.local/state}/night-shift
mkdir -p "$STATE/logs"
today=$(date -u +%F)
log=$STATE/logs/$today.log
exec >>"$log" 2>&1
echo "=== night shift $(date -u +%FT%TZ)"

# The box has 1 GB. Idle agent sessions of the day may still be alive (and mostly swapped out); a busy one is not.
busy=$(ps -eo pcpu=,args= | awk '/[c]laude --output-format/ && $1 > 5' | wc -l)
if [ "$busy" -gt 0 ] && [ -z "${NIGHT_SHIFT_FORCE:-}" ]; then echo "an agent session is busy; skipping tonight"; exit 0; fi
[ -r "$HOME/.config/posthog/key" ] || { echo "no PostHog key at ~/.config/posthog/key"; exit 1; }

# A worktree of its own, on the latest master, so the owner's checkout is never touched.
git -C "$REPO" fetch -q origin || exit 1
[ -d "$WT" ] || git -C "$REPO" worktree add -q --detach "$WT" origin/master || exit 1
cd "$WT" && git checkout -q --detach origin/master && git reset -q --hard && git clean -qfdx -e node_modules
[ -e node_modules ] || ln -s "$REPO/node_modules" node_modules

since=$(cat "$STATE/last-success" 2>/dev/null || date -u -d '7 days ago' +%FT%TZ)
prompt=$(sed -e "s|{{SINCE}}|$since|g" -e "s|{{TODAY}}|$today|g" -e "s|{{STATE}}|$STATE|g" "$WT/scripts/night-shift/prompt.md")

start=$(date -u +%FT%TZ)
timeout 4h nice -n 10 claude -p "$prompt" --model claude-opus-5-5 --permission-mode bypassPermissions --output-format text
code=$?
echo "=== agent exited $code at $(date -u +%FT%TZ)"
[ "$code" = 0 ] && echo "$start" > "$STATE/last-success"
# Whatever the agent left behind (it should leave nothing).
pkill -f '[v]ite preview' ; pkill -f '[p]laywright test'
cd "$WT" && git checkout -q --detach origin/master 2>/dev/null
find "$STATE/logs" -name '*.log' -mtime +30 -delete
exit "$code"
