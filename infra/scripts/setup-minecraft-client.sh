#!/bin/bash
set -euo pipefail

MC_VERSION="${1:-1.21.4}"
CLIENT_DIR="/home/ubuntu/minecraft-client"
FABRIC_INSTALLER_URL="https://meta.fabricmc.net/v2/versions/installer"

echo "=== Setting up Minecraft Client (Fabric + Sodium) $MC_VERSION ==="

mkdir -p "$CLIENT_DIR"
cd "$CLIENT_DIR"

# -------------------------------------------------------
# 1. Fabric Installer
# -------------------------------------------------------
echo "Downloading Fabric installer..."
INSTALLER_VERSION=$(curl -s "$FABRIC_INSTALLER_URL" | jq -r '.[0].version')
curl -Lo fabric-installer.jar \
  "https://maven.fabricmc.net/net/fabricmc/fabric-installer/$INSTALLER_VERSION/fabric-installer-$INSTALLER_VERSION.jar"

echo "Installing Fabric client for MC $MC_VERSION..."
java -jar fabric-installer.jar client \
  -dir "$CLIENT_DIR" \
  -mcversion "$MC_VERSION" \
  -noprofile

# -------------------------------------------------------
# 2. バニラ client.jar + ライブラリ + アセット
# -------------------------------------------------------
echo "Downloading vanilla client and libraries..."

python3 << PYEOF
import json, os, urllib.request, sys

client_dir = "$CLIENT_DIR"
mc_version = "$MC_VERSION"
libs_dir = os.path.join(client_dir, "libraries")
natives_dir = os.path.join(client_dir, "natives")
os.makedirs(natives_dir, exist_ok=True)

# --- Version manifest ---
print("  Fetching version manifest...")
manifest_url = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
with urllib.request.urlopen(manifest_url) as r:
    manifest = json.loads(r.read())

version_url = None
for v in manifest["versions"]:
    if v["id"] == mc_version:
        version_url = v["url"]
        break
if not version_url:
    print(f"ERROR: MC version {mc_version} not found")
    sys.exit(1)

with urllib.request.urlopen(version_url) as r:
    version_data = json.loads(r.read())

# Save for classpath builder
vanilla_json = os.path.join(client_dir, "vanilla-version.json")
with open(vanilla_json, "w") as f:
    json.dump(version_data, f)

# --- Client JAR ---
client_jar_dir = os.path.join(client_dir, "versions", mc_version)
client_jar = os.path.join(client_jar_dir, f"{mc_version}.jar")
if not os.path.exists(client_jar):
    os.makedirs(client_jar_dir, exist_ok=True)
    url = version_data["downloads"]["client"]["url"]
    print(f"  Downloading client.jar...")
    urllib.request.urlretrieve(url, client_jar)

# --- Asset index ---
asset_index = version_data["assetIndex"]
asset_index_id = asset_index["id"]
index_dir = os.path.join(client_dir, "assets", "indexes")
index_file = os.path.join(index_dir, f"{asset_index_id}.json")
if not os.path.exists(index_file):
    os.makedirs(index_dir, exist_ok=True)
    urllib.request.urlretrieve(asset_index["url"], index_file)
    print(f"  Asset index: {asset_index_id}")

# --- Fabric libraries (from Fabric version JSON) ---
fabric_dir = None
versions_dir = os.path.join(client_dir, "versions")
for d in os.listdir(versions_dir):
    if d.startswith("fabric-loader-"):
        fabric_dir = d
        break

fabric_json_path = os.path.join(versions_dir, fabric_dir, fabric_dir + ".json")
with open(fabric_json_path) as f:
    fabric_data = json.load(f)

fabric_lib_keys = set()
for lib in fabric_data["libraries"]:
    parts = lib["name"].split(":")
    fabric_lib_keys.add(f"{parts[0]}:{parts[1]}")

# --- Download vanilla libraries ---
count = 0
for lib in version_data["libraries"]:
    rules = lib.get("rules", [])
    if rules:
        allowed = False
        for rule in rules:
            os_rule = rule.get("os", {})
            if os_rule:
                if os_rule.get("name") == "linux":
                    allowed = (rule["action"] == "allow")
            else:
                allowed = (rule["action"] == "allow")
        if not allowed:
            continue

    downloads = lib.get("downloads", {})
    artifact = downloads.get("artifact")
    if artifact:
        path = os.path.join(libs_dir, artifact["path"])
        if not os.path.exists(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            urllib.request.urlretrieve(artifact["url"], path)
            count += 1

print(f"  Downloaded {count} vanilla libraries")

# --- Extract LWJGL natives ---
import zipfile, glob
native_jars = glob.glob(os.path.join(libs_dir, "**/*natives-linux*.jar"), recursive=True)
for jar_path in native_jars:
    with zipfile.ZipFile(jar_path, 'r') as zf:
        for name in zf.namelist():
            if name.endswith(".so"):
                zf.extract(name, natives_dir)
print(f"  Extracted natives from {len(native_jars)} JARs")

# --- Build classpath.txt ---
cp_parts = []

# Fabric libraries first (priority for ASM etc.)
for lib in fabric_data["libraries"]:
    parts = lib["name"].split(":")
    group_path = parts[0].replace(".", "/")
    artifact = parts[1]
    version = parts[2]
    jar_path = os.path.join(libs_dir, group_path, artifact, version, f"{artifact}-{version}.jar")
    if os.path.exists(jar_path):
        cp_parts.append(jar_path)

# Vanilla libraries (excluding Fabric-provided duplicates)
for lib in version_data["libraries"]:
    parts = lib["name"].split(":")
    key = f"{parts[0]}:{parts[1]}"
    if key in fabric_lib_keys:
        continue

    rules = lib.get("rules", [])
    if rules:
        allowed = False
        for rule in rules:
            os_rule = rule.get("os", {})
            if os_rule:
                if os_rule.get("name") == "linux":
                    allowed = (rule["action"] == "allow")
            else:
                allowed = (rule["action"] == "allow")
        if not allowed:
            continue

    downloads = lib.get("downloads", {})
    artifact = downloads.get("artifact")
    if artifact:
        jar_path = os.path.join(libs_dir, artifact["path"])
        if os.path.exists(jar_path):
            cp_parts.append(jar_path)

# Client JAR last
cp_parts.append(client_jar)

cp_file = os.path.join(client_dir, "classpath.txt")
with open(cp_file, "w") as f:
    f.write(":".join(cp_parts))
print(f"  Classpath: {len(cp_parts)} JARs written to classpath.txt")

# Save asset index ID for launch.sh
with open(os.path.join(client_dir, "asset-index-id.txt"), "w") as f:
    f.write(asset_index_id)

# --- Download assets ---
print("  Downloading assets (this may take a few minutes)...")
with open(index_file) as f:
    index_data = json.load(f)

objects = index_data.get("objects", {})
dl_count = 0
for name, info in objects.items():
    h = info["hash"]
    prefix = h[:2]
    dest = os.path.join(client_dir, f"assets/objects/{prefix}/{h}")
    if os.path.exists(dest):
        continue
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    url = f"https://resources.download.minecraft.net/{prefix}/{h}"
    try:
        urllib.request.urlretrieve(url, dest)
        dl_count += 1
    except Exception as e:
        print(f"  WARN: {name}: {e}", file=sys.stderr)

print(f"  Assets: {dl_count} downloaded, {len(objects)} total")
PYEOF

# -------------------------------------------------------
# 3. Mods (Sodium, Lithium, Fabric API)
# -------------------------------------------------------
echo "Downloading mods..."
MODS_DIR="$CLIENT_DIR/mods"
mkdir -p "$MODS_DIR"

SODIUM_URL=$(curl -s "https://api.modrinth.com/v2/project/AANobbMI/version?game_versions=%5B%22$MC_VERSION%22%5D&loaders=%5B%22fabric%22%5D" \
  | jq -r '.[0].files[0].url // empty')

if [ -n "$SODIUM_URL" ]; then
  curl -Lo "$MODS_DIR/sodium.jar" "$SODIUM_URL"
  echo "Sodium downloaded."
fi

LITHIUM_URL=$(curl -s "https://api.modrinth.com/v2/project/gvQqBUqZ/version?game_versions=%5B%22$MC_VERSION%22%5D&loaders=%5B%22fabric%22%5D" \
  | jq -r '.[0].files[0].url // empty')

if [ -n "$LITHIUM_URL" ]; then
  curl -Lo "$MODS_DIR/lithium.jar" "$LITHIUM_URL"
  echo "Lithium downloaded."
fi

FABRIC_API_URL=$(curl -s "https://api.modrinth.com/v2/project/P7dR8mSH/version?game_versions=%5B%22$MC_VERSION%22%5D&loaders=%5B%22fabric%22%5D" \
  | jq -r '.[0].files[0].url // empty')

if [ -n "$FABRIC_API_URL" ]; then
  curl -Lo "$MODS_DIR/fabric-api.jar" "$FABRIC_API_URL"
  echo "Fabric API downloaded."
fi

# -------------------------------------------------------
# 4. options.txt (最低グラフィック + 24fps)
# -------------------------------------------------------
cat > "$CLIENT_DIR/options.txt" << 'EOF'
version:3465
autoJump:false
maxFps:24
fov:70
gamma:1.0
renderDistance:4
simulationDistance:5
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
joinedFirstServer:true
skipMultiplayerWarning:true
onboardAccessibility:false
skipRealmsNotifications:true
tutorialStep:none
EOF

# -------------------------------------------------------
# 5. launch.sh
# -------------------------------------------------------
ASSET_INDEX_ID=$(cat "$CLIENT_DIR/asset-index-id.txt")

cat > "$CLIENT_DIR/launch.sh" << LAUNCH
#!/bin/bash
set -euo pipefail

export DISPLAY=:99
export MESA_GL_VERSION_OVERRIDE=4.5
export MESA_GLSL_VERSION_OVERRIDE=450
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export LP_NUM_THREADS=2

MC_DIR="/home/ubuntu/minecraft-client"
cd "\$MC_DIR"

CLASSPATH=\$(cat "\$MC_DIR/classpath.txt")
NATIVES_PATH="\$MC_DIR/natives/linux/x64/org/lwjgl:\$MC_DIR/natives"
FABRIC_LOADER=\$(ls -d versions/fabric-loader-*/ 2>/dev/null | head -1 | xargs basename)

exec java \\
  -Xmx1536M -Xms1024M \\
  -XX:+UseG1GC \\
  -XX:MaxGCPauseMillis=50 \\
  -Djava.library.path="\$NATIVES_PATH" \\
  -DFabricMcEmu=" net.minecraft.client.main.Main " \\
  -cp "\$CLASSPATH" \\
  net.fabricmc.loader.impl.launch.knot.KnotClient \\
  --gameDir "\$MC_DIR" \\
  --assetsDir "\$MC_DIR/assets" \\
  --assetIndex $ASSET_INDEX_ID \\
  --version "\$FABRIC_LOADER" \\
  --width 1280 --height 720 \\
  --quickPlayMultiplayer "localhost:25565" \\
  --username AI_Rei
LAUNCH

chmod +x "$CLIENT_DIR/launch.sh"

# -------------------------------------------------------
# 6. 初回ウェルカム画面自動スキップスクリプト
# -------------------------------------------------------
cat > "$CLIENT_DIR/skip-welcome.sh" << 'SKIPEOF'
#!/bin/bash
# MC Client 初回起動時のウェルカム画面を自動スキップ
# systemd の ExecStartPost で呼ぶ想定
sleep 30
DISPLAY=:99 xdotool mousemove 640 680 click 1
echo "Clicked 'Continue' on welcome screen"
SKIPEOF
chmod +x "$CLIENT_DIR/skip-welcome.sh"

chown -R ubuntu:ubuntu "$CLIENT_DIR"

echo "=== Minecraft Client setup complete ==="
echo "  - Fabric + Sodium (GPU-free, LLVMpipe rendering)"
echo "  - 24fps cap, render distance 4, minimal graphics"
echo "  - 1280x720 resolution"
