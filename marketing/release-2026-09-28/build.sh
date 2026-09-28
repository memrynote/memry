#!/usr/bin/env bash
# Rebuild the film: palette + brand data -> cue export -> score -> picture (motion blur) -> mux at -14 LUFS.
# Usage: ./build.sh           full rebuild, about 11 min on an M5 Pro
#        ./build.sh --audio   keep the rendered picture, rebuild and remux only the audio
set -euo pipefail
cd "$(dirname "$0")"
TMP=${TMPDIR:-/tmp}/memry-release
OUT=memrynote-release-2026-09-28.mp4
mkdir -p "$TMP"

node themes.mjs
node brand.mjs
# frames of shots/vaults.mp4 are re-extracted by render.mjs, so an edited recording is never stale
rm -rf frames
node render.mjs --events
# the committed copies went through the pre-commit prettier; match them so a build leaves no diff
pnpm exec prettier --write --log-level warn themes.js brand.js events.json
uv run --quiet --with numpy --with scipy python score.py "$TMP/score.wav"
if [[ "${1:-}" == "--audio" ]]; then
  ffmpeg -y -loglevel error -i "$OUT" -map 0:v -c copy "$TMP/video.mp4"
else
  node render.mjs --out "$TMP/video.mp4" --workers 10
fi

# static gain to -14 LUFS integrated, no limiter: the score already peaks at -1 dBTP and sits above -14
i=$(ffmpeg -hide_banner -nostats -i "$TMP/score.wav" -af ebur128=framelog=quiet -f null - 2>&1 | awk '$1=="I:"{v=$2} END{print v}')
gain=$(python3 -c "print(round(-14 - float('$i'), 2))")
if python3 -c "import sys; sys.exit(0 if float('$gain') > 0 else 1)"; then
  echo "warning: score is quieter than -14 LUFS, a +$gain dB gain would clip; muxing at unity" >&2
  gain=0
fi
echo "$OUT: integrated $i LUFS -> gain $gain dB"
ffmpeg -y -loglevel error -i "$TMP/video.mp4" -i "$TMP/score.wav" -map 0:v -map 1:a -c:v copy \
  -af "volume=${gain}dB" -c:a aac -b:a 320k -ar 48000 -movflags +faststart -shortest "$OUT"
echo "wrote $OUT"
