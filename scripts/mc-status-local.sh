#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MC_DEV_DIR="${MC_DEV_DIR:-$ROOT_DIR/.minecraft-dev}"
MC_DIR="$MC_DEV_DIR/server"
PID_FILE="$MC_DIR/server.pid"
LOG_FILE="$MC_DIR/server.log"

if [[ ! -f "$MC_DIR/server.jar" ]]; then
  echo "[mc:status] not-installed"
  exit 0
fi

if [[ ! -f "$PID_FILE" ]]; then
  echo "[mc:status] stopped"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "$PID" ]] || ! kill -0 "$PID" 2>/dev/null; then
  echo "[mc:status] stopped (stale pid file)"
  exit 0
fi

if grep -q 'Done (' "$LOG_FILE" 2>/dev/null; then
  echo "[mc:status] ready pid=$PID port=25565"
else
  echo "[mc:status] starting pid=$PID"
fi

if [[ -f "$MC_DIR/server.properties" ]]; then
  SEED="$(grep '^level-seed=' "$MC_DIR/server.properties" | cut -d= -f2- || true)"
  if [[ -n "$SEED" ]]; then
    echo "[mc:status] configured-seed=$SEED"
  else
    echo "[mc:status] configured-seed=random"
  fi
fi
