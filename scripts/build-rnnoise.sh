#!/bin/sh
# Builds src/client/rnnoise/rnnoise-little.wasm: xiph RNNoise with its "little" model, as a standalone wasm with SIMD
# (ticket 26). The output is committed, so neither CI nor a deploy needs emscripten; run this only to change the build.
# Needs podman or docker, and network for the source and the model (about 60 MB).
#
# SIMD comes from RNNoise's own x86 AVX code path, which emscripten translates to 128-bit wasm SIMD. Measured in the
# noise spike (branch prototype/noise-spike): about 4x faster than @shiguredo/rnnoise-wasm with the full model; -mavx2
# and -mrelaxed-simd were no faster, plain -msse4.1 does not compile (vec_avx.h needs __m256i). The default 64 KB stack
# overflows inside RNNoise, hence 1 MB.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/src/client/rnnoise"
WORK=${WORK:-/tmp/dave-rnnoise-build}
COMMIT=70f1d256acd4b34a572f999a05c87bf00b67730d # xiph/rnnoise main, 2025-02-22; its model_version pins the weights
IMAGE=docker.io/emscripten/emsdk:6.0.10
ENGINE=$(command -v podman || command -v docker)

mkdir -p "$WORK" "$OUT"
[ -d "$WORK/rnnoise" ] || git clone -q https://github.com/xiph/rnnoise.git "$WORK/rnnoise"
git -C "$WORK/rnnoise" checkout -q "$COMMIT"
(cd "$WORK/rnnoise" && { [ -f src/rnnoise_data_little.c ] || sh download_model.sh >/dev/null; })

cat > "$WORK/inner.sh" <<'EOF'
set -e
# The sources include rnnoise_data.h by name; the little model has a header of its own, so build in a copy where it takes that name.
rm -rf /tmp/little && cp -r /work/rnnoise /tmp/little && cd /tmp/little && cp src/rnnoise_data_little.h src/rnnoise_data.h
emcc -O3 -DNDEBUG -Iinclude -Isrc -msimd128 -mavx \
  -sSTANDALONE_WASM --no-entry -sALLOW_MEMORY_GROWTH=1 -sMALLOC=emmalloc -sSTACK_SIZE=1048576 \
  -sEXPORTED_FUNCTIONS=_rnnoise_create,_rnnoise_destroy,_rnnoise_process_frame,_malloc,_free \
  src/denoise.c src/rnn.c src/pitch.c src/kiss_fft.c src/celt_lpc.c src/nnet.c src/nnet_default.c \
  src/parse_lpcnet_weights.c src/rnnoise_tables.c src/rnnoise_data_little.c \
  -o /out/rnnoise-little.wasm 2>/dev/null
EOF
"$ENGINE" run --rm -v "$WORK:/work:Z" -v "$OUT:/out:Z" "$IMAGE" sh /work/inner.sh
cp "$WORK/rnnoise/COPYING" "$OUT/COPYING"
ls -la "$OUT"
