#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MC_DEV_DIR="${MC_DEV_DIR:-$ROOT_DIR/.minecraft-dev}"
MC_DIR="$MC_DEV_DIR/server"
SEED="${1:-${MC_SEED:-}}"

if [[ ! -f "$MC_DIR/server.properties" ]]; then
  echo "ERROR: local Minecraft server is not set up." >&2
  echo "Run: npm run mc:setup" >&2
  exit 1
fi

if [[ -n "$SEED" && ! "$SEED" =~ ^-?[0-9]+$ ]]; then
  echo "ERROR: development reset currently accepts a numeric Minecraft seed only." >&2
  exit 1
fi

bash "$ROOT_DIR/scripts/mc-stop-local.sh"

rm -rf \
  "$MC_DIR/world" \
  "$MC_DIR/world_nether" \
  "$MC_DIR/world_the_end"

if [[ -n "$SEED" ]]; then
  sed -i -E "s/^level-seed=.*/level-seed=${SEED}/" "$MC_DIR/server.properties"
  echo "[mc:reset] World removed. Next world seed: $SEED"
else
  sed -i -E 's/^level-seed=.*/level-seed=/' "$MC_DIR/server.properties"
  echo "[mc:reset] World removed. Next world seed: random"
fi

rm -f "$MC_DIR/server.log"

if [[ "${MC_RESET_NO_START:-0}" == "1" ]]; then
  echo "[mc:reset] Not starting server because MC_RESET_NO_START=1."
  exit 0
fi

MC_SEED="$SEED" bash "$ROOT_DIR/scripts/mc-start-local.sh"
