#!/bin/bash
set -euo pipefail

LOG="/var/log/ai-minecraft-provision.log"
exec > >(tee -a "$LOG") 2>&1

echo "=== ai-minecraft provisioning started: $(date -u) ==="

PROVISION_FLAG="/home/ubuntu/.provisioning-done"

if [ -f "$PROVISION_FLAG" ]; then
  echo "Already provisioned, skipping."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive

# -------------------------------------------------------
# Phase 1: OS パッケージインストール
# -------------------------------------------------------
echo "=== Phase 1: Installing base packages ==="

apt-get update -y
apt-get upgrade -y
apt-get install -y \
  build-essential git curl wget unzip awscli jq \
  software-properties-common apt-transport-https ca-certificates gnupg

# Xvfb + Mesa (ソフトウェア OpenGL) + xdotool (GUI 自動操作)
apt-get install -y xvfb mesa-utils libegl-mesa0 libgl1-mesa-dri libglx-mesa0 xdotool

# FFmpeg (CPU エンコード: libx264)
apt-get install -y ffmpeg

# ImageMagick + 日本語フォント
apt-get install -y imagemagick fonts-noto-cjk

# PulseAudio
apt-get install -y pulseaudio pulseaudio-utils

# Java 21 — フル JRE (MC Client が LWJGL/OpenGL を使うため headless では不可)
apt-get install -y openjdk-21-jre

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io
usermod -aG docker ubuntu

# VOICEVOX コンテナ (CPU版)
docker pull voicevox/voicevox_engine:cpu-latest
docker run -d \
  --name voicevox \
  --restart always \
  -p 50021:50021 \
  voicevox/voicevox_engine:cpu-latest

# -------------------------------------------------------
# Phase 2: アプリケーション clone + build
# -------------------------------------------------------
echo "=== Phase 2: Application setup ==="

if [ ! -d "/home/ubuntu/ai-minecraft" ]; then
  su - ubuntu -c "git clone ${github_repo} /home/ubuntu/ai-minecraft"
fi
cd /home/ubuntu/ai-minecraft
su - ubuntu -c "cd /home/ubuntu/ai-minecraft && npm install && npm run build"

# -------------------------------------------------------
# Phase 3: コンポーネントセットアップ (clone 済みのスクリプトを使用)
# -------------------------------------------------------
echo "=== Phase 3: Component setup ==="

# PulseAudio 仮想シンク
bash /home/ubuntu/ai-minecraft/infra/scripts/setup-pulseaudio.sh

# Minecraft Server
bash /home/ubuntu/ai-minecraft/infra/scripts/setup-minecraft.sh "${minecraft_version}"

# Minecraft Client (Fabric + Sodium, ソフトウェア描画)
bash /home/ubuntu/ai-minecraft/infra/scripts/setup-minecraft-client.sh "${minecraft_version}"

# -------------------------------------------------------
# Phase 4: systemd + .env
# -------------------------------------------------------
echo "=== Phase 4: Services and config ==="

cp /home/ubuntu/ai-minecraft/infra/scripts/systemd/*.service /etc/systemd/system/
systemctl daemon-reload

systemctl enable xvfb.service
systemctl enable minecraft-server.service
systemctl enable minecraft-client.service
systemctl enable voicevox.service
systemctl enable avatar-writer.service
systemctl enable ffmpeg-stream.service
systemctl enable orchestrator.service

systemctl start xvfb.service
systemctl start minecraft-server.service

# .env テンプレート作成
ENV_FILE="/home/ubuntu/ai-minecraft/.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << 'ENVEOF'
# === LLM ===
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=
LLM_MODEL=claude-sonnet-4-20250514

# === YouTube ===
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REFRESH_TOKEN=
YOUTUBE_CHANNEL_ID=
YOUTUBE_STREAM_KEY=

# === Minecraft ===
MINECRAFT_HOST=localhost
MINECRAFT_PORT=25565

# === VOICEVOX ===
VOICEVOX_HOST=http://localhost:50021

# === Database ===
DB_PATH=./data/ai-minecraft.db

# === Dashboard ===
DASHBOARD_PORT=8080

# === S3 ===
S3_BUCKET=
AWS_REGION=ap-northeast-1

# === Operation Mode ===
OPERATION_MODE=MANUAL
ENVEOF
  chown ubuntu:ubuntu "$ENV_FILE"
fi

# Terraform から渡された値を .env に書き込み
sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${anthropic_api_key}|" "$ENV_FILE"
sed -i "s|^S3_BUCKET=.*|S3_BUCKET=${s3_bucket}|" "$ENV_FILE"
sed -i "s|^AWS_REGION=.*|AWS_REGION=${aws_region}|" "$ENV_FILE"

# データディレクトリ
su - ubuntu -c "mkdir -p /home/ubuntu/ai-minecraft/data"

# --- 完了 ---
touch "$PROVISION_FLAG"
chown ubuntu:ubuntu "$PROVISION_FLAG"

echo "=== ai-minecraft provisioning complete: $(date -u) ==="
