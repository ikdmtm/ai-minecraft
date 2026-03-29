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

# voicevox_sink → combined_sink
load-module module-loopback source=voicevox_sink.monitor sink=combined_sink latency_msec=30

# game_sink → combined_sink
load-module module-loopback source=game_sink.monitor sink=combined_sink latency_msec=30
EOF

chown -R ubuntu:ubuntu "$PA_CONFIG"

echo "=== PulseAudio virtual sinks configured ==="
