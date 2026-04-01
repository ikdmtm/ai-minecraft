#!/bin/bash
set -euo pipefail

echo "=== Setting up PulseAudio virtual sinks ==="

PA_CONFIG="/home/ubuntu/.config/pulse"
mkdir -p "$PA_CONFIG"

cat > "$PA_CONFIG/default.pa" << 'EOF'
.include /etc/pulse/default.pa

# VOICEVOX 音声用シンク
load-module module-null-sink sink_name=voicevox_sink sink_properties=device.description="VOICEVOX"

# Minecraft ゲーム音用シンク
load-module module-null-sink sink_name=game_sink sink_properties=device.description="GameAudio"

# 合成出力シンク（FFmpeg がキャプチャ）
load-module module-null-sink sink_name=combined_sink sink_properties=device.description="CombinedOutput"

# voicevox_sink → combined_sink (100% volume)
load-module module-loopback source=voicevox_sink.monitor sink=combined_sink latency_msec=30

# game_sink → combined_sink (will be set to 35% below)
load-module module-loopback source=game_sink.monitor sink=combined_sink latency_msec=30

# デフォルト出力先を combined_sink に
set-default-sink combined_sink
EOF

chown -R ubuntu:ubuntu "$PA_CONFIG"

# PulseAudio 再起動後に音量を設定するスクリプト
cat > "$PA_CONFIG/set-volumes.sh" << 'VOLEOF'
#!/bin/bash
# Wait for PulseAudio to be ready
for i in $(seq 1 10); do
  pactl info &>/dev/null && break
  sleep 1
done

# Voice sink: 100% volume
pactl set-sink-volume voicevox_sink 100%

# Game sink: 35% volume (game audio should be quieter than voice)
pactl set-sink-volume game_sink 35%

# Combined output: 100%
pactl set-sink-volume combined_sink 100%

# Move Minecraft to game_sink if running
# (MC client uses default sink, so set game_sink for its PID)
for idx in $(pactl list short sink-inputs | awk '{print $1}'); do
  pactl move-sink-input "$idx" game_sink 2>/dev/null || true
done

echo "Audio volumes set: voice=100%, game=35%" || true
exit 0
VOLEOF
chmod +x "$PA_CONFIG/set-volumes.sh"

echo "=== PulseAudio virtual sinks configured ==="
echo "Run ~/.config/pulse/set-volumes.sh after PulseAudio starts to set volumes"
