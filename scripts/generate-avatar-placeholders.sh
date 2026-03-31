#!/bin/bash
# 300x400 アバター用プレースホルダー PNG を生成（ImageMagick）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$ROOT/assets/avatar"
mkdir -p "$OUT"

declare -A COLORS=(
  [normal]="#4A90D9"
  [serious]="#5C6B7A"
  [sad]="#6B7C9E"
  [surprised]="#E8A838"
  [happy]="#E85D75"
  [thinking]="#8B6BB0"
)

for expr in normal serious sad surprised happy thinking; do
  color="${COLORS[$expr]}"
  for mouth in open closed; do
    out="$OUT/${expr}_${mouth}.png"
    mouth_note=""
    if [[ "$mouth" == "open" ]]; then
      mouth_note="(口開)"
    else
      mouth_note="(口閉)"
    fi
    convert -size 300x400 "xc:${color}" \
      -gravity center \
      -pointsize 22 \
      -fill white \
      -annotate +0-80 "Rei" \
      -pointsize 16 \
      -annotate +0+40 "${expr}" \
      -pointsize 14 \
      -annotate +0+80 "${mouth_note}" \
      "$out"
    echo "Wrote $out"
  done
done

echo "Done: 12 placeholder avatars in $OUT"
