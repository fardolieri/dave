#!/usr/bin/env bash
# Runs the headless-Chromium drive scripts against a deployed app and fails on what they report as trouble:
# exceptions, console warnings, connection badges that never settle, a refused room, a browser that never came up.
# usage: scripts/ci-browser.sh <url> <secret-prefix> [outdir]     CHROME picks the browser, as for the scripts themselves.
# Each script gets a room of its own (<prefix>, <prefix>-drive, <prefix>-share). Logs and screenshots land in outdir.
set -uo pipefail
url=$1; prefix=$2; out=${3:-browser-out}
mkdir -p "$out/shots"
fail=0
run() {
  local name=$1; shift
  echo "::group::$name"
  "$@" 2>&1 | tee "$out/$name.log"
  local rc=${PIPESTATUS[0]}
  echo "::endgroup::"
  if [ "$rc" != 0 ]; then echo "::error::$name exited with $rc"; fail=1; fi
}
run first-visit node scripts/first-visit.mjs "$url" "$prefix" Vicky
sleep 30 # the Worker allows 10 socket upgrades per minute per IP; the scripts reconnect on purpose, so give the window time to pass
run drive node scripts/drive.mjs --join --share --shot="$out/shots" "$url" "$prefix-drive" Alice Bob Carol
sleep 30
run drive-share node scripts/drive-share.mjs "$url" "$prefix-share"

grep -q 'no console errors or exceptions' "$out/first-visit.log" || { echo "::error::first-visit reported problems"; fail=1; }
bad='EXCEPTION|console\.warn|NOT settled|Refused:|did not open a debugging port|no debugging port|^(Type|Reference|Syntax)?Error'
if grep -En "$bad" "$out"/*.log; then echo "::error::the browser scripts reported trouble, see the lines above"; fail=1; fi
[ "$fail" = 0 ] && echo "browser scripts clean"
exit $fail
