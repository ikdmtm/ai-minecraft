#!/bin/bash
set -euo pipefail

MC_VERSION="${1:-1.21.4}"
CLIENT_DIR="/home/ubuntu/minecraft-client"
FABRIC_INSTALLER_URL="https://meta.fabricmc.net/v2/versions/installer"

echo "=== Setting up Minecraft Client (Fabric + Sodium) $MC_VERSION ==="

mkdir -p "$CLIENT_DIR"
cd "$CLIENT_DIR"

# --- Fabric Installer ---
echo "Downloading Fabric installer..."
INSTALLER_VERSION=$(curl -s "$FABRIC_INSTALLER_URL" | jq -r '.[0].version')
curl -Lo fabric-installer.jar \
  "https://maven.fabricmc.net/net/fabricmc/fabric-installer/$INSTALLER_VERSION/fabric-installer-$INSTALLER_VERSION.jar"

echo "Installing Fabric client for MC $MC_VERSION..."
java -jar fabric-installer.jar client \
  -dir "$CLIENT_DIR" \
  -mcversion "$MC_VERSION" \
  -noprofile

# --- Sodium mod ---
echo "Downloading Sodium mod..."
MODS_DIR="$CLIENT_DIR/mods"
mkdir -p "$MODS_DIR"

SODIUM_URL=$(curl -s "https://api.modrinth.com/v2/project/AANobbMI/version?game_versions=%5B%22$MC_VERSION%22%5D&loaders=%5B%22fabric%22%5D" \
  | jq -r '.[0].files[0].url // empty')

if [ -n "$SODIUM_URL" ]; then
  curl -Lo "$MODS_DIR/sodium.jar" "$SODIUM_URL"
  echo "Sodium downloaded."
else
  echo "WARNING: Sodium not found for MC $MC_VERSION, proceeding without it."
fi

# --- Lithium (server-side optimization, helps with tick performance) ---
LITHIUM_URL=$(curl -s "https://api.modrinth.com/v2/project/gvQqBUqZ/version?game_versions=%5B%22$MC_VERSION%22%5D&loaders=%5B%22fabric%22%5D" \
  | jq -r '.[0].files[0].url // empty')

if [ -n "$LITHIUM_URL" ]; then
  curl -Lo "$MODS_DIR/lithium.jar" "$LITHIUM_URL"
  echo "Lithium downloaded."
fi

# --- Fabric API (required by some mods) ---
FABRIC_API_URL=$(curl -s "https://api.modrinth.com/v2/project/P7dR8mSH/version?game_versions=%5B%22$MC_VERSION%22%5D&loaders=%5B%22fabric%22%5D" \
  | jq -r '.[0].files[0].url // empty')

if [ -n "$FABRIC_API_URL" ]; then
  curl -Lo "$MODS_DIR/fabric-api.jar" "$FABRIC_API_URL"
  echo "Fabric API downloaded."
fi

# --- Minecraft options.txt (最低グラフィック設定 + 24fps キャップ) ---
cat > "$CLIENT_DIR/options.txt" << 'EOF'
version:3465
autoJump:false
maxFps:24
fov:70
gamma:1.0
renderDistance:4
simulationDistance:4
entityDistanceScaling:0.5
guiScale:2
particles:2
graphicsMode:0
ao:false
prioritizeChunkUpdates:0
biomeBlendRadius:0
renderClouds:"false"
resourcePacks:[]
entityShadows:false
fullscreen:false
vsync:false
mipmapLevels:0
reducedDebugInfo:false
soundCategory_master:1.0
soundCategory_music:0.0
soundCategory_record:0.5
soundCategory_weather:0.3
soundCategory_block:0.8
soundCategory_hostile:1.0
soundCategory_neutral:0.5
soundCategory_player:1.0
soundCategory_ambient:0.5
soundCategory_voice:1.0
overrideWidth:1280
overrideHeight:720
EOF

# --- launch.sh (Mesa LLVMpipe ソフトウェア描画) ---
cat > "$CLIENT_DIR/launch.sh" << 'LAUNCH'
#!/bin/bash
set -euo pipefail

export DISPLAY=:99
export MESA_GL_VERSION_OVERRIDE=4.5
export MESA_GLSL_VERSION_OVERRIDE=450
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export LP_NUM_THREADS=2

MC_DIR="/home/ubuntu/minecraft-client"
MC_VERSION="__MC_VERSION__"

cd "$MC_DIR"

FABRIC_LOADER=$(ls versions/fabric-loader-*/fabric-loader-*.json 2>/dev/null | head -1 | xargs -I{} basename {} .json)

if [ -z "$FABRIC_LOADER" ]; then
  echo "ERROR: Fabric loader not found"
  exit 1
fi

exec java \
  -Xmx1536M -Xms1024M \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=50 \
  -Djava.library.path="$MC_DIR/natives" \
  -cp "$MC_DIR/libraries/*:$MC_DIR/versions/$FABRIC_LOADER/$FABRIC_LOADER.jar" \
  net.fabricmc.loader.impl.launch.knot.KnotClient \
  --gameDir "$MC_DIR" \
  --assetsDir "$MC_DIR/assets" \
  --assetIndex "$MC_VERSION" \
  --version "$FABRIC_LOADER" \
  --width 1280 --height 720 \
  --server localhost --port 25565 \
  --username AI_Rei
LAUNCH

sed -i "s|__MC_VERSION__|$MC_VERSION|g" "$CLIENT_DIR/launch.sh"
chmod +x "$CLIENT_DIR/launch.sh"

chown -R ubuntu:ubuntu "$CLIENT_DIR"

echo "=== Minecraft Client setup complete ==="
echo "  - Fabric + Sodium (GPU-free, LLVMpipe rendering)"
echo "  - 24fps cap, render distance 4, minimal graphics"
echo "  - 1280x720 resolution"
