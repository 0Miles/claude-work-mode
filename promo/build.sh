#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${DIR}/.." && pwd)"

echo "=== 1. Fitting 60s BGM ==="
vk run audio.bgm-fit \
  input="/Users/danyuchn/claude-course/promo-videos/hyperframes/c1v2-tutor-methods/audio/music.wav" \
  output="${DIR}/audio/bgm-60s.m4a" \
  duration=60.0 fade_in=1.0 fade_out=2.5 --overwrite

echo "=== 2. Composing Traditional Chinese project ==="
vk run visual.compose \
  scenes="${DIR}/zh/scenes.json" \
  cues="${DIR}/zh/cues.json" \
  audio="${DIR}/audio/bgm-60s.m4a" \
  output="${DIR}/zh/project" \
  --overwrite

echo "=== 3. Rendering Chinese video ==="
(cd "${DIR}/zh/project" && hyperframes render --output "${DIR}/claude-work-mode-promo-zh.raw.mp4")
vk run audio.loudnorm \
  input="${DIR}/claude-work-mode-promo-zh.raw.mp4" \
  output="${DIR}/claude-work-mode-promo-zh.mp4" \
  preset=youtube --overwrite
rm -f "${DIR}/claude-work-mode-promo-zh.raw.mp4"

echo "=== 4. Composing English project ==="
vk run visual.compose \
  scenes="${DIR}/en/scenes.json" \
  cues="${DIR}/en/cues.json" \
  audio="${DIR}/audio/bgm-60s.m4a" \
  output="${DIR}/en/project" \
  --overwrite

echo "=== 5. Rendering English video ==="
(cd "${DIR}/en/project" && hyperframes render --output "${DIR}/claude-work-mode-promo-en.raw.mp4")
vk run audio.loudnorm \
  input="${DIR}/claude-work-mode-promo-en.raw.mp4" \
  output="${DIR}/claude-work-mode-promo-en.mp4" \
  preset=youtube --overwrite
rm -f "${DIR}/claude-work-mode-promo-en.raw.mp4"

echo "=== 6. Delivery Quality Control ==="
vk run qc.delivery input="${DIR}/claude-work-mode-promo-zh.mp4"
vk run qc.delivery input="${DIR}/claude-work-mode-promo-en.mp4"

echo "=== 7. Generating lightweight README demos (720p, ~1MB) & Posters ==="
ffmpeg -hide_banner -loglevel error -y -i "${DIR}/claude-work-mode-promo-zh.mp4" \
  -vf "scale=1280:720" -c:v libx264 -crf 30 -preset slow -c:a aac -b:a 64k "${DIR}/claude-work-mode-demo-zh.mp4"
ffmpeg -hide_banner -loglevel error -y -i "${DIR}/claude-work-mode-promo-en.mp4" \
  -vf "scale=1280:720" -c:v libx264 -crf 30 -preset slow -c:a aac -b:a 64k "${DIR}/claude-work-mode-demo-en.mp4"
ffmpeg -hide_banner -loglevel error -y -ss 00:00:15 -i "${DIR}/claude-work-mode-demo-zh.mp4" -vframes 1 "${DIR}/demo-poster-zh.png"
ffmpeg -hide_banner -loglevel error -y -ss 00:00:15 -i "${DIR}/claude-work-mode-demo-en.mp4" -vframes 1 "${DIR}/demo-poster-en.png"

echo "All renders completed and verified successfully!"
