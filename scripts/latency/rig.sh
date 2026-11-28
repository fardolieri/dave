#!/usr/bin/env bash
# Mouth to ear, browser to browser (ticket 96, e2e/latency/): starts a PulseAudio of its own with the rig's devices, runs
# the latency scenarios against a local build, prints the table, and stops it all again.
#
#   mix     a stereo sink, recorded as it plays: left is Alice's microphone, right is Bob's speaker, on one clock
#   micA    Alice's microphone: the left channel of mix
#   bobout  Bob's speaker: writes into the right channel of mix
#   sinkA   Alice's speaker, heard by nobody; quiet: Bob's silent microphone (its monitor)
#
# Needs pulseaudio, pactl, paplay and parecord on the PATH. Environment:
#   LATENCY_LOAD=N      N busy loops beside the browsers, at their priority (a game hogging the CPU)
#   LATENCY_REPEAT=N    every scenario N times (default 1)
#   LATENCY_ONLY=a,b    only these scenarios (floor, webrtc, webrtc-webaudio, webrtc-destination, dave, dave-no-noise-removal)
#   LATENCY_OUT=dir     where the recordings and results go (default latency-results)
#   LATENCY_PA_DIR=dir  PulseAudio's socket and log (default /tmp/dave-latency-$UID; a socket path must stay short)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${LATENCY_OUT:-latency-results}
PA=${LATENCY_PA_DIR:-/tmp/dave-latency-$(id -u)}
mkdir -p "$OUT" "$PA/config"
rm -f "$PA/native"

# A desktop's rate: Chromium opens its streams at the server's default.
printf 'default-sample-rate = 48000\nalternate-sample-rate = 48000\n' > "$PA/config/daemon.conf"
cat > "$PA/rig.pa" <<EOF
load-module module-native-protocol-unix socket=$PA/native auth-anonymous=1
load-module module-null-sink sink_name=mix rate=48000 channels=2 channel_map=front-left,front-right
load-module module-remap-sink sink_name=bobout master=mix channels=1 channel_map=mono master_channel_map=front-right remix=no
load-module module-remap-source source_name=micA master=mix.monitor channels=1 channel_map=mono master_channel_map=front-left remix=no
load-module module-null-sink sink_name=sinkA rate=48000
load-module module-null-sink sink_name=quiet rate=48000
EOF
export PULSE_SERVER=unix:$PA/native PULSE_RUNTIME_PATH=$PA
# Debug level: the log is where each underrun of a browser's speaker shows (the spec counts them).
PULSE_CONFIG_PATH=$PA/config pulseaudio -n -F "$PA/rig.pa" --daemonize=no --exit-idle-time=-1 --use-pid-file=no \
  --disallow-exit -vvvv --log-target=file:"$PA/pulse.log" > "$PA/pulse.out" 2>&1 &
PULSE_PID=$!
LOAD_PIDS=()
cleanup() {
  for p in "${LOAD_PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  kill "$PULSE_PID" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 50); do [ -S "$PA/native" ] && pactl info > /dev/null 2>&1 && break; sleep 0.2; done
pactl info > /dev/null || { cat "$PA/pulse.out"; exit 1; }

# The speech, on the left channel only (a mono file would go to both).
SIGNAL="$OUT/signal.ogg"
cp e2e/latency/speech.ogg "$SIGNAL"

for _ in $(seq "${LATENCY_LOAD:-0}"); do node -e 'for (;;) {}' & LOAD_PIDS+=($!); done

LATENCY_SIGNAL=$SIGNAL LATENCY_PA_LOG=$PA/pulse.log LATENCY_OUT=$OUT \
  pnpm exec playwright test -c playwright.latency.config.ts
