#!/usr/bin/env bash
# Turns the receipt videos (receipts-out/<phone|desktop>/<test>.webm, playwright.receipts.config.ts) into looping GIFs in
# <out>/<phone|desktop>/<test>.gif, next to each test's <test>.json (title, outcome, and the seconds before the app was up).
#
# GIF, not MP4: GitHub shows an image from any URL inline in a comment, a GIF plays there on a phone without a tap, and a
# video only plays from GitHub's own attachment storage, which has no API. Each GIF is kept under 3 MB, the size a phone
# loads quickly on mobile data: frame rate and width step down until it fits.
set -euo pipefail
src=${1:-receipts-out}
out=${2:-receipts-gif}
limit=$((3 * 1024 * 1024))

shopt -s nullglob
for webm in "$src"/*/*.webm; do
  rel=${webm#"$src"/}
  gif="$out/${rel%.webm}.gif"
  mkdir -p "$(dirname "$gif")"
  cp "${webm%.webm}.json" "${gif%.gif}.json"
  # The phone is filmed 390 wide, the desktop 1280: the desktop starts out scaled down to what a phone shows anyway.
  # The page loading and connecting is cut: the first frame is what a still preview of the GIF shows.
  skip=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).skip ?? 0" "${webm%.webm}.json")
  case "$rel" in phone/*) widths=(390 320 260) ;; *) widths=(800 640 480) ;; esac
  for i in 0 1 2; do
    fps=$((10 - 3 * i))
    # One palette for the whole clip, built from what changes between frames (the UI is mostly still), and only the
    # changed rectangle of each frame stored.
    ffmpeg -loglevel error -y -ss "$skip" -i "$webm" -vf "fps=$fps,scale=${widths[$i]}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 "$gif" \
      || { echo "::warning::$webm could not be turned into a GIF"; rm -f "$gif"; continue 2; }
    size=$(stat -c %s "$gif")
    echo "$gif: ${widths[$i]} px wide, $fps fps, $((size / 1024)) KB"
    [ "$size" -le "$limit" ] && break
  done
done
