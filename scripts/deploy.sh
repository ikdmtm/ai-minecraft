#!/bin/bash
set -euo pipefail

# AI Minecraft アプリケーションデプロイスクリプト
# EC2 上で実行: bash scripts/deploy.sh

APP_DIR="/home/ubuntu/ai-minecraft"
BRANCH="${1:-main}"

echo "=== Deploying ai-minecraft (branch: $BRANCH) ==="

cd "$APP_DIR"

echo "[1/5] Fetching latest code..."
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

echo "[2/5] Installing dependencies..."
npm ci --production=false

echo "[3/5] Building..."
npm run build

echo "[4/8] Syncing systemd units..."
sudo cp infra/scripts/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload

echo "[5/8] Syncing PulseAudio config..."
bash infra/scripts/setup-pulseaudio.sh

echo "[6/8] Syncing runtime config..."
bash infra/scripts/sync-runtime-config.sh

echo "[7/8] Restarting Minecraft services and orchestrator..."
sudo systemctl restart minecraft-server.service
sudo systemctl restart minecraft-client.service
sudo systemctl restart orchestrator.service

echo "[8/8] Verifying..."
sleep 3
if systemctl is-active --quiet orchestrator.service; then
  echo "orchestrator is running."
else
  echo "WARNING: orchestrator failed to start. Check logs:"
  echo "  journalctl -u orchestrator.service -n 30"
  exit 1
fi

echo "=== Deploy complete ==="
