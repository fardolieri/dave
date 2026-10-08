#!/usr/bin/env bash
# Installs the night shift timer for this user (systemd user instance; lingering must be on so it runs without a login).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p ~/.config/systemd/user ~/.local/libexec
cp "$here/run.sh" ~/.local/libexec/dave-night-shift.sh
cp "$here/night-shift.service" "$here/night-shift.timer" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now night-shift.timer
systemctl --user list-timers night-shift.timer --no-pager
