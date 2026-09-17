#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MC_VERSION="${MC_VERSION:-1.21.4}"
MC_DEV_DIR="${MC_DEV_DIR:-$ROOT_DIR/.minecraft-dev}"
MC_DIR="$MC_DEV_DIR/server"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq
require_cmd java

JAVA_VERSION_LINE="$(java -version 2>&1 | head -n 1 || true)"
echo "[mc:setup] Java: $JAVA_VERSION_LINE"
echo "[mc:setup] Minecraft server: $MC_VERSION"
echo "[mc:setup] Directory: $MC_DIR"

mkdir -p "$MC_DIR"

MANIFEST_URL="https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
VERSION_URL="$(curl -fsSL "$MANIFEST_URL" | jq -r --arg version "$MC_VERSION" '.versions[] | select(.id == $version) | .url' | head -n 1)"

if [[ -z "$VERSION_URL" || "$VERSION_URL" == "null" ]]; then
  echo "ERROR: Minecraft version '$MC_VERSION' was not found in Mojang version manifest." >&2
  exit 1
fi

SERVER_URL="$(curl -fsSL "$VERSION_URL" | jq -r '.downloads.server.url')"
if [[ -z "$SERVER_URL" || "$SERVER_URL" == "null" ]]; then
  echo "ERROR: server download URL was not found for Minecraft $MC_VERSION." >&2
  exit 1
fi

TMP_JAR="$MC_DIR/server.jar.tmp"
curl -fL "$SERVER_URL" -o "$TMP_JAR"
mv "$TMP_JAR" "$MC_DIR/server.jar"

echo "eula=true" > "$MC_DIR/eula.txt"

cat > "$MC_DIR/server.properties" <<'EOF'
server-port=25565
gamemode=survival
difficulty=hard
hardcore=true
max-players=4
online-mode=false
spawn-protection=0
view-distance=8
simulation-distance=6
level-name=world
level-seed=
motd=AI Minecraft Gameplay Development
pvp=false
allow-nether=true
allow-flight=true
enable-rcon=false
enable-command-block=false
white-list=false
EOF

cat > "$MC_DIR/README.txt" <<EOF
Local development Minecraft server for ai-minecraft.
Minecraft version: $MC_VERSION
Created by: scripts/mc-setup-local.sh

This directory is intentionally gitignored.
Use npm run mc:start / mc:stop / mc:reset to manage it.
EOF

mkdir -p "$ROOT_DIR/data"

echo "[mc:setup] Complete."
echo "[mc:setup] Next: npm run mc:start"
