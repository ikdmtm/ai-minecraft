#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MC_DEV_DIR="${MC_DEV_DIR:-$ROOT_DIR/.minecraft-dev}"
MC_DIR="$MC_DEV_DIR/server"
PID_FILE="$MC_DIR/server.pid"
STOP_TIMEOUT_SECONDS="${MC_STOP_TIMEOUT_SECONDS:-30}"

if [[ ! -f "$PID_FILE" ]]; then
  echo "[mc:stop] Not running (no pid file)."
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "$PID" ]] || ! kill -0 "$PID" 2>/dev/null; then
  echo "[mc:stop] Not running (stale pid file)."
  rm -f "$PID_FILE"
  exit 0
fi

echo "[mc:stop] Stopping Minecraft server (pid=$PID)..."
kill "$PID" 2>/dev/null || true

for ((i=0; i<STOP_TIMEOUT_SECONDS; i++)); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "[mc:stop] Stopped."
    exit 0
  fi
  sleep 1
done

echo "[mc:stop] Graceful stop timed out; sending SIGKILL." >&2
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
