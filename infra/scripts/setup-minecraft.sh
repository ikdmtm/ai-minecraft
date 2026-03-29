#!/bin/bash
set -euo pipefail

MC_VERSION="${1:-1.21.4}"
MC_DIR="/home/ubuntu/minecraft-server"

echo "=== Setting up Minecraft Server $MC_VERSION ==="

mkdir -p "$MC_DIR"
cd "$MC_DIR"

# サーバー JAR ダウンロード（version_manifest_v2 から URL 取得）
MANIFEST_URL="https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
VERSION_URL=$(curl -s "$MANIFEST_URL" | jq -r ".versions[] | select(.id==\"$MC_VERSION\") | .url")

if [ -z "$VERSION_URL" ] || [ "$VERSION_URL" = "null" ]; then
  echo "ERROR: Minecraft version $MC_VERSION not found in manifest"
  exit 1
fi

SERVER_URL=$(curl -s "$VERSION_URL" | jq -r '.downloads.server.url')
curl -o server.jar "$SERVER_URL"

# EULA 同意
echo "eula=true" > eula.txt

# server.properties
cat > server.properties << 'EOF'
server-port=25565
gamemode=survival
difficulty=hard
hardcore=true
max-players=1
online-mode=false
spawn-protection=0
enable-command-block=true
view-distance=6
simulation-distance=4
level-name=world
motd=AI Minecraft Hardcore
pvp=false
allow-nether=true
enable-rcon=false
EOF

chown -R ubuntu:ubuntu "$MC_DIR"

echo "=== Minecraft Server $MC_VERSION setup complete ==="
