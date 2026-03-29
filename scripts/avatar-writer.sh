#!/bin/bash
set -euo pipefail

# AvatarRenderer が書き出す表情ファイルを読み、
# 対応する PNG を RGBA 生データに変換して named pipe に書き込む。
# FFmpeg が rawvideo として読み取りオーバーレイ合成する。

PIPE="/tmp/ai-minecraft-avatar.pipe"
EXPRESSION_FILE="/tmp/ai-minecraft-avatar-expr.txt"
WIDTH=300
HEIGHT=400
FRAME_BYTES=$((WIDTH * HEIGHT * 4))
INTERVAL=0.2

cleanup() {
  rm -f "$PIPE"
  exit 0
}
trap cleanup SIGTERM SIGINT

[ -p "$PIPE" ] || mkfifo "$PIPE"

LAST_IMG=""
CACHED_FRAME=""

while true; do
  IMG=$(cat "$EXPRESSION_FILE" 2>/dev/null || echo "")

  if [ -z "$IMG" ] || [ ! -f "$IMG" ]; then
    # No expression set yet or file missing — write transparent frame
    dd if=/dev/zero bs="$FRAME_BYTES" count=1 2>/dev/null
    sleep "$INTERVAL"
    continue
  fi

  if [ "$IMG" != "$LAST_IMG" ]; then
    CACHED_FRAME=$(mktemp)
    convert "$IMG" -resize "${WIDTH}x${HEIGHT}!" -depth 8 RGBA:- > "$CACHED_FRAME" 2>/dev/null || true
    LAST_IMG="$IMG"
  fi

  if [ -f "$CACHED_FRAME" ]; then
    cat "$CACHED_FRAME"
  else
    dd if=/dev/zero bs="$FRAME_BYTES" count=1 2>/dev/null
  fi

  sleep "$INTERVAL"
done > "$PIPE"
