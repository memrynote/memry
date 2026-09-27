#!/usr/bin/env bash
# Rebuild the film: cue export -> scores -> picture (motion blur) -> mux both cuts at -14 LUFS.
# Usage: ./build.sh           full rebuild, about 6 min on an M5 Pro
#        ./build.sh --audio   keep the rendered picture, rebuild and remux only the audio
# The narration stems in vo/ are inputs here. narrate.py records them (see README).
set -euo pipefail
cd "$(dirname "$0")"
TMP=${TMPDIR:-/tmp}/memry-film
OUT=memrynote-explainer-30s.mp4
OUT_VO=memrynote-explainer-30s-voiceover.mp4
mkdir -p "$TMP"

node render.mjs --events
uv run --quiet --with numpy --with scipy python score.py "$TMP/score.wav"
uv run --quiet --with numpy --with scipy python score.py "$TMP/score_vo.wav" --vo
if [[ "${1:-}" == "--audio" ]]; then
  ffmpeg -y -loglevel error -i "$OUT" -map 0:v -c copy "$TMP/video.mp4"
else
  node render.mjs --out "$TMP/video.mp4" --workers 10
fi

# static gain to -14 LUFS integrated, no limiter: both scores already peak at -1 dBFS
mux() {
  local in=$1 out=$2 i gain
  i=$(ffmpeg -hide_banner -nostats -i "$in" -af ebur128=framelog=quiet -f null - 2>&1 | awk '$1=="I:"{v=$2} END{print v}')
  gain=$(python3 -c "print(round(-14 - float('$i'), 2))")
  echo "$out: integrated $i LUFS -> gain $gain dB"
  ffmpeg -y -loglevel error -i "$TMP/video.mp4" -i "$in" -map 0:v -map 1:a -c:v copy \
    -af "volume=${gain}dB" -c:a aac -b:a 320k -ar 48000 -movflags +faststart -shortest "$out"
}
mux "$TMP/score.wav" "$OUT"
mux "$TMP/score_vo.wav" "$OUT_VO"
echo "wrote $OUT $OUT_VO"
