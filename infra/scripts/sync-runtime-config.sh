#!/bin/bash
set -euo pipefail

MC_SERVER_DIR="/home/ubuntu/minecraft-server"
MC_CLIENT_LAUNCH="/home/ubuntu/minecraft-client/launch.sh"
BOT_USERNAME="AI_Rei"
CAMERA_USERNAME="StreamCamera"

echo "=== Syncing runtime config for current architecture ==="

if [ -f "$MC_SERVER_DIR/server.properties" ]; then
  if grep -q '^max-players=' "$MC_SERVER_DIR/server.properties"; then
    sed -i 's/^max-players=.*/max-players=2/' "$MC_SERVER_DIR/server.properties"
  else
    printf '\nmax-players=2\n' >> "$MC_SERVER_DIR/server.properties"
  fi

  if grep -q '^allow-flight=' "$MC_SERVER_DIR/server.properties"; then
    sed -i 's/^allow-flight=.*/allow-flight=true/' "$MC_SERVER_DIR/server.properties"
  else
    printf '\nallow-flight=true\n' >> "$MC_SERVER_DIR/server.properties"
  fi
fi

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

if [ -f "$MC_CLIENT_LAUNCH" ]; then
  sed -i 's/--username AI_Rei/--username StreamCamera/' "$MC_CLIENT_LAUNCH"
fi

chown ubuntu:ubuntu "$MC_SERVER_DIR/ops.json" "$MC_CLIENT_LAUNCH" 2>/dev/null || true

echo "=== Runtime config sync complete ==="
