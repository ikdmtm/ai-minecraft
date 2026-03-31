# GPU 切替手順 (c5.xlarge → g4dn.xlarge)

GPU 上限緩和が承認されたら、以下のファイルを変更してインスタンスを再作成する。

## 変更一覧

### 1. infra/variables.tf
```
- default = "c5.xlarge"
+ default = "g4dn.xlarge"

- default = 30   # root_volume_size
+ default = 100  # NVMe + 余裕
```

### 2. infra/terraform.tfvars
```
- instance_type = "c5.xlarge"
+ instance_type = "g4dn.xlarge"

- root_volume_size = 30
+ root_volume_size = 100
```

### 3. infra/scripts/user-data.sh
- Mesa 関連パッケージ (`mesa-utils` 等) を削除
- NVIDIA ドライバ + VirtualGL のインストールを復活（Phase 1 再起動含む）
- Minecraft Client セットアップの `launch.sh` から LLVMpipe 環境変数を除去
- NVMe インスタンスストレージのマウントを復活

### 4. infra/scripts/setup-minecraft-client.sh の launch.sh 部分
```
- export LIBGL_ALWAYS_SOFTWARE=1
- export GALLIUM_DRIVER=llvmpipe
- export LP_NUM_THREADS=2
+ (GPU ネイティブ描画なのでこれらの環境変数は不要)
```
- `exec java ...` の前に `vglrun` を追加

### 5. infra/scripts/systemd/minecraft-client.service
```
- Environment=LIBGL_ALWAYS_SOFTWARE=1
- Environment=GALLIUM_DRIVER=llvmpipe
- Environment=LP_NUM_THREADS=2
- Environment=MESA_GL_VERSION_OVERRIDE=4.5
- Environment=MESA_GLSL_VERSION_OVERRIDE=450
- CPUAffinity=0 1
+ ExecStart=/usr/bin/vglrun /home/ubuntu/minecraft-client/launch.sh
```

### 6. FFmpeg（配信エンコード）

`ffmpeg-stream.service` は廃止済み。エンコード引数は **`src/index.ts` の `startFFmpegWithHud` が渡す `FFmpegConfig`**（実体は `src/stream/ffmpeg.ts` の `buildFFmpegArgs`）で決まる。

GPU 切替時は libx264 → h264_nvenc 等へ変更し、解像度・ビットレート・fps を調整する。例:

```
- libx264 -preset ultrafast -tune zerolatency -b:v 2500k ... -r 30
+ h264_nvenc -preset p4 -b:v 4500k -maxrate 5000k -bufsize 10000k -r 30
```

### 7. infra/scripts/systemd/minecraft-server.service
```
- CPUAffinity=3
+ (削除)

- ExecStart=/usr/bin/java -Xmx2G -Xms1G ...
+ ExecStart=/usr/bin/java -Xmx4G -Xms2G ...
```

### 8. infra/scripts/systemd/orchestrator.service
```
- CPUAffinity=3
+ (削除)
```

### 9. infra/scripts/setup-minecraft.sh
```
- view-distance=6
+ view-distance=10

- simulation-distance=4
+ simulation-distance=8
```

### 10. Minecraft Client options.txt
```
- maxFps:24
+ maxFps:60

- renderDistance:4
+ renderDistance:10

- graphicsMode:0 (fast)
+ graphicsMode:1 (fancy)

- particles:2 (minimal)
+ particles:0 (all)

- ao:false
+ ao:true
```

### 11. src/stream/ffmpeg.ts
```
- '-preset', 'ultrafast',
- '-tune', 'zerolatency',
+ '-preset', 'llhq',

- '-r', String(config.fps),
+ (削除: GPU なら fps cap 不要)
```

### 12. src/stream/ffmpeg.test.ts
- `ultrafast` → `llhq` に変更
- `zerolatency` のテスト削除
- fps cap テスト削除

## 実行手順

```bash
# 1. ファイル修正後
cd infra
terraform plan   # 差分確認
terraform apply  # 新インスタンス作成

# 2. プロビジョニング完了待ち (NVIDIA ドライバ再起動あり、約 20 分)
ssh ubuntu@<new_ip> tail -f /var/log/ai-minecraft-provision.log

# 3. GPU 確認
ssh ubuntu@<new_ip> nvidia-smi
```

## コスト比較

| 構成 | 時間単価 | 月額(24h) |
|---|---|---|
| c5.xlarge (CPU) | ~$0.20/h | ~$152 |
| g4dn.xlarge (GPU) | ~$0.71/h | ~$525 |
