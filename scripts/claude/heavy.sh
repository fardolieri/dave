#!/usr/bin/env bash
# The heavy processes on this machine (dev servers, workerd, the test browsers, a playwright run) and whose they are, for
# the hooks (stop-check.sh, session-start.sh). Several agent sessions work here at once, and what one of them runs is not
# another's to stop.
#
# An agent session is a process named `claude` with no other claude above it in its cgroup (a `claude -p` an agent runs
# is part of the agent's session). T3 Code starts every session in a cgroup scope of its own, and everything in that
# scope is the session's: what it runs, and what it let go of (`cmd &` in a shell that ended, Chromium's crash handler,
# setsid), which no longer runs under it. Where sessions share a cgroup (a CI runner, terminals), a process is the
# session's it runs under.
#
# One line each, tab-separated: the owner, then the pid and command. The owner is
#   mine                  the session this script runs under
#   orphan                no running session: left behind by one that ended, or started outside any (the owner, T3)
#   session <pid> <dir>   another session, still running: its claude process and the directory it works in
list=$(pgrep -fa '[w]orkerd|[v]ite (dev|preview)|[c]hrome-linux|[h]eadless_shell|[m]s-playwright/firefox|[p]laywright test' 2>/dev/null)
[ -z "$list" ] && exit 0

declare -A dirs
awk -v self=$$ '
  # The line of the unified hierarchy ("0::/user.slice/..."), or "" where there is none worth telling apart (the root).
  function cgroup(p,   f, line, g) {
    if (p in cg) return cg[p]
    f = "/proc/" p "/cgroup"; g = ""
    while ((getline line < f) > 0) if (line ~ /^0::/) g = substr(line, 4)
    close(f)
    return cg[p] = g == "/" ? "" : g
  }
  # The nearest claude above a process, or "".
  function above(p,   n) { for (n = 0; n < 64 && (p = up[p]) > 1; n++) if (name[p] == "claude") return p; return "" }
  # The session a claude is part of: the outermost claude above it in its cgroup, or itself.
  function outermost(c,   g, q) { g = cgroup(c); for (q = above(c); q != ""; q = above(q)) if (cgroup(q) == g) c = q; return c }
  # Whose a process is: the one session in its cgroup, else the session it runs under, else "".
  function session(p,   g, s) {
    g = cgroup(p)
    if (g != "" && sessions[g] == 1) return in_cgroup[g]
    return (s = above(p)) == "" ? "" : outermost(s)
  }
  NR == FNR { up[$1] = $2; name[$1] = $3; next }
  FNR == 1 {
    for (c in name) if (name[c] == "claude" && (g = cgroup(c)) != "" && outermost(c) == c) { sessions[g]++; in_cgroup[g] = c }
    mine = session(self)
  }
  # Gone since pgrep saw it, or a shell or claude itself whose command line carries the words (an agent'"'"'s Bash tool).
  !($1 in up) || name[$1] ~ /^(claude|bash|sh|dash|zsh)$/ { next }
  {
    pid = $1; s = session(pid)
    owner = s == "" ? "orphan" : s == mine ? "mine" : "session " s
    sub(/^[0-9]+ /, "")
    printf "%s\t%s %s\n", owner, pid, $0
  }
' <(ps -eo pid=,ppid=,comm=) <(printf '%s\n' "$list") |
  while IFS=$'\t' read -r owner rest; do
    case $owner in session*)
      p=${owner#session }
      [ -z "${dirs[$p]+set}" ] && dirs[$p]=$(readlink "/proc/$p/cwd")
      # A session that ended since owns nothing any more; one whose directory cannot be read still runs.
      if [ ! -d "/proc/$p" ]; then owner=orphan; else owner="$owner ${dirs[$p]:-?}"; fi ;;
    esac
    printf '%s\t%s\n' "$owner" "$rest"
  done
