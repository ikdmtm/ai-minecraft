#!/bin/bash
set -euo pipefail

MC_VERSION="${1:-1.21.4}"
MC_DIR="/home/ubuntu/minecraft-server"
BOT_USERNAME="AI_Rei"
CAMERA_USERNAME="StreamCamera"

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
max-players=2
online-mode=false
spawn-protection=0
enable-command-block=true
view-distance=6
simulation-distance=5
level-name=world
motd=AI Minecraft Hardcore
pvp=false
allow-nether=true
allow-flight=true
enable-rcon=false
EOF

BOT_USERNAME="$BOT_USERNAME" CAMERA_USERNAME="$CAMERA_USERNAME" node <<'NODE'
const crypto = require('crypto');
const fs = require('fs');

function offlineUuid(name) {
  const input = Buffer.from(`OfflinePlayer:${name}`, 'utf8');
  const hash = crypto.createHash('md5').update(input).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ops = [process.env.BOT_USERNAME, process.env.CAMERA_USERNAME].map((name) => ({
  uuid: offlineUuid(name),
  name,
  level: 4,
  bypassesPlayerLimit: true,
}));

fs.writeFileSync('/home/ubuntu/minecraft-server/ops.json', `${JSON.stringify(ops, null, 2)}\n`);
NODE

chown -R ubuntu:ubuntu "$MC_DIR"

echo "=== Minecraft Server $MC_VERSION setup complete ==="
