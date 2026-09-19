#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MC_DEV_DIR="${MC_DEV_DIR:-$ROOT_DIR/.minecraft-dev}"
MC_DIR="$MC_DEV_DIR/server"
PID_FILE="$MC_DIR/server.pid"
LOG_FILE="$MC_DIR/server.log"
XMS="${MC_JAVA_XMS:-1G}"
XMX="${MC_JAVA_XMX:-2G}"
START_TIMEOUT_SECONDS="${MC_START_TIMEOUT_SECONDS:-90}"

if [[ ! -f "$MC_DIR/server.jar" ]]; then
  echo "ERROR: local Minecraft server is not set up." >&2
  echo "Run: npm run mc:setup" >&2
  exit 1
fi

# World identity follows the actual world directory, not its seed or a process generation.
WORLD_ID_FILE="${GAMEPLAY_WORLD_ID_FILE:-$MC_DIR/world/.ai-world-id}"
mkdir -p "$(dirname "$WORLD_ID_FILE")"
if [[ ! -s "$WORLD_ID_FILE" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import uuid; print(uuid.uuid4())' > "$WORLD_ID_FILE"
  else
    cat /proc/sys/kernel/random/uuid > "$WORLD_ID_FILE"
  fi
fi

# Cached extraction is cheap on restarts. Missing Python does not silently invent recipe facts.
if command -v python3 >/dev/null 2>&1; then
  python3 "$ROOT_DIR/scripts/mc-export-knowledge.py" "$MC_DIR/server.jar" "${GAMEPLAY_KNOWLEDGE_FILE:-$ROOT_DIR/data/minecraft-knowledge.json}"
else
  echo "[mc:knowledge] python3 unavailable; registry-only knowledge." >&2
fi

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "[mc:start] Already running (pid=$PID)."
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if [[ -n "${MC_SEED:-}" ]]; then
  sed -i -E "s/^level-seed=.*/level-seed=${MC_SEED}/" "$MC_DIR/server.properties"
fi

cd "$MC_DIR"
: > "$LOG_FILE"

# Fully detach the Java server from the one-touch launcher.
# Redirect stdin as well as stdout/stderr and create a new session so npm/bash
# cannot keep the reset command alive through the server process.
nohup setsid java "-Xms$XMS" "-Xmx$XMX" -jar server.jar nogui \
  </dev/null >> "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"

echo "[mc:start] Starting Minecraft server (pid=$PID, heap=$XMS..$XMX)..."

for ((i=0; i<START_TIMEOUT_SECONDS; i++)); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "ERROR: Minecraft server exited during startup." >&2
    tail -n 80 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi

  if grep -q 'Done (' "$LOG_FILE" 2>/dev/null; then
    echo "[mc:start] Ready on localhost:25565"
    exit 0
  fi

  sleep 1
done

echo "ERROR: Minecraft server did not become ready within ${START_TIMEOUT_SECONDS}s." >&2
tail -n 80 "$LOG_FILE" >&2 || true
exit 1
