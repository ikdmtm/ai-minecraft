#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/logs/gameplay"
DEFAULT_TEST_SEED="${AI_MC_TEST_SEED:-8675309}"

if (( $# == 0 )); then
  # Gameplay-development default: every run starts from the same fresh world
  # so before/after behavior can be compared from spawn.
  set -- reset "$DEFAULT_TEST_SEED"
elif [[ "${1:-}" == "continue" ]]; then
  shift
  set -- start "$@"
fi

mkdir -p "$LOG_DIR"

RUN_ID="$(date '+%Y%m%d-%H%M%S')"
RUN_LOG="$LOG_DIR/run-${RUN_ID}.log"
LATEST_LOG="$LOG_DIR/latest.log"

ln -sfn "$(basename "$RUN_LOG")" "$LATEST_LOG"
export AI_MC_RUN_LOG="$RUN_LOG"

exec > >(tee -a "$RUN_LOG") 2>&1

printf '\n============================================================\n'
printf '[AI Minecraft] Run started: %s\n' "$(date -Iseconds)"
printf '[AI Minecraft] Mode: %s\n' "$*"
printf '[AI Minecraft] Run log: %s\n' "$RUN_LOG"
printf '[AI Minecraft] Latest log: %s\n' "$LATEST_LOG"
printf '============================================================\n\n'

exec bash "$ROOT_DIR/scripts/dev-one-touch.sh" "$@"
