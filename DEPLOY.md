# デプロイ手順: AWS 環境構築から配信テストまで

## 全体の流れ

```
[Step 0] 事前準備（ローカル PC）
    ↓
[Step 1] AWS 認証情報の設定
    ↓
[Step 2] Terraform 変数ファイルの作成
    ↓
[Step 3] Terraform でインフラ構築
    ↓
[Step 4] プロビジョニング完了を待つ
    ↓
[Step 5] SSH 接続して動作確認
    ↓
[Step 6] YouTube API の準備（Google Cloud Console）
    ↓
[Step 7] YouTube OAuth トークン取得（ローカル PC）
    ↓
[Step 8] EC2 の .env に YouTube 情報を設定
    ↓
[Step 9] 配信テスト（MANUAL モード）
    ↓
[Step 10] 監視と確認
    ↓
[付録] インスタンスの停止・削除
```

---

## Step 0: 事前準備

以下が手元の PC にインストールされていること:

| ツール | 確認コマンド | なければ |
|---|---|---|
| Terraform | `terraform version` | https://developer.hashicorp.com/terraform/install |
| AWS CLI | `aws --version` | `curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip && unzip awscliv2.zip && sudo ./aws/install` |
| Node.js 20+ | `node --version` | https://nodejs.org/ |
| SSH キー | `ls ~/.ssh/id_ed25519.pub` | `ssh-keygen -t ed25519` で生成 |

### AWS アカウント

- AWS アカウントが必要（https://aws.amazon.com/ で作成）
- IAM ユーザーを作成し、以下の権限を付与:
  - `AmazonEC2FullAccess`
  - `AmazonS3FullAccess`
  - `IAMFullAccess`
- IAM ユーザーの「アクセスキー」を発行しておく（アクセスキー ID + シークレットアクセスキー）

### Anthropic API キー

- https://console.anthropic.com/ でアカウント作成
- API Keys ページでキーを発行（`sk-ant-api03-...` の形式）
- クレジットをチャージ済みであること

---

## Step 1: AWS 認証情報の設定

Terraform が AWS にアクセスするための認証情報を設定する。
これは「どの AWS アカウントに対してリソースを作るか」を指定する作業。

```bash
aws configure
```

対話形式で以下を入力:

```
AWS Access Key ID [None]: AKIA...（IAM ユーザーのアクセスキー ID）
AWS Secret Access Key [None]: wJal...（IAM ユーザーのシークレットアクセスキー）
Default region name [None]: ap-northeast-1
Default output format [None]: json
```

設定確認:
```bash
aws sts get-caller-identity
```

自分のアカウント ID とユーザー名が表示されれば OK。

---

## Step 2: Terraform 変数ファイルの作成

`terraform.tfvars` は Terraform が使う設定値を入れるファイル。
Git に含めない秘密情報もここに書く。

```bash
cd ai-minecraft/infra
cp terraform.tfvars.example terraform.tfvars
```

`terraform.tfvars` を編集:

```hcl
# AWS リージョン（東京）。変更不要。
region = "ap-northeast-1"

# EC2 インスタンスのスペック（CPU のみ、GPU 不要）。
# CPU 描画構成: c5.xlarge (4vCPU/8GB, ~$0.20/h)
# GPU 承認後:    g4dn.xlarge に変更可 (docs/gpu-switchover.md 参照)
instance_type = "c5.xlarge"

# SSH 公開鍵のパス。
# EC2 に SSH 接続するときに使う鍵ペアの「公開鍵」側。
# ssh-keygen で生成済みの公開鍵パスを指定。
ssh_public_key_path = "~/.ssh/id_ed25519.pub"

# SSH 接続を許可する IP アドレス。
# 自分の PC のグローバル IP を指定する（自分以外からの SSH を遮断するため）。
# 以下のコマンドで取得:
#   curl -s ifconfig.me
# 取得した IP の末尾に /32 を付ける（例: 203.0.113.42/32）。
my_ip = "203.0.113.42/32"

# GitHub リポジトリ URL。EC2 起動時にこのリポジトリのコードを自動 clone する。
# 自分のリポジトリの URL に変更。
github_repo = "https://github.com/your-username/ai-minecraft.git"

# Anthropic API キー。EC2 の .env に自動書き込みされる。
anthropic_api_key = "sk-ant-api03-xxxxx"

# Minecraft サーバーバージョン。変更不要。
minecraft_version = "1.21.4"

# EC2 のディスク容量（GB）。30GB で十分。変更不要。
root_volume_size = 30
```

**各項目の説明:**

| 項目 | 何を設定するか | どこで取得するか |
|---|---|---|
| `region` | AWS のデータセンター所在地 | そのまま（東京リージョン） |
| `instance_type` | サーバーのスペック | c5.xlarge（CPU 描画構成） |
| `ssh_public_key_path` | SSH の公開鍵ファイル | `ls ~/.ssh/*.pub` で確認 |
| `my_ip` | 自分のグローバル IP | `curl -s ifconfig.me` を実行 |
| `github_repo` | コードのリポジトリ | GitHub のリポジトリページ URL |
| `anthropic_api_key` | LLM の API キー | https://console.anthropic.com/settings/keys |
| `minecraft_version` | Minecraft バージョン | そのまま |
| `root_volume_size` | ディスク容量 | そのまま |

---

## Step 3: Terraform でインフラ構築

Terraform は「このファイルに書いてある通りの AWS リソースを作って」というツール。
3 つのコマンドを順番に実行する。

### 3-1. 初期化（プラグインのダウンロード）

```bash
cd ai-minecraft/infra
terraform init
```

AWS と通信するための Terraform プラグインがダウンロードされる。初回のみ必要。

### 3-2. 実行計画の確認（ドライラン）

```bash
terraform plan
```

**実際にはまだ何も作らない。** 「これから何を作るか」の一覧が表示される。
以下のようなリソースが表示されるはず:

- `aws_instance.main` — EC2 サーバー本体
- `aws_security_group.main` — ファイアウォール設定
- `aws_eip.main` — 固定 IP アドレス
- `aws_key_pair.main` — SSH 鍵の登録
- `aws_s3_bucket.recordings` — 録画保存用ストレージ
- `aws_iam_role.ec2` — EC2 → S3 アクセス権限

末尾に `Plan: 10 to add, 0 to change, 0 to destroy.` のような表示があれば OK。

### 3-3. リソース作成（本番実行）

```bash
terraform apply
```

`Do you want to perform these actions?` と聞かれるので `yes` と入力。

**ここで実際に AWS リソースが作成される（課金が発生する）。**

完了すると以下が出力される:

```
Outputs:

dashboard_tunnel = "ssh -L 8080:localhost:8080 -i <秘密鍵パス> ubuntu@13.xxx.xxx.xxx"
instance_id = "i-0abcdef1234567890"
public_ip = "13.xxx.xxx.xxx"
s3_bucket = "ai-minecraft-recordings-xxxxx"
ssh_command = "ssh -i <秘密鍵パス> ubuntu@13.xxx.xxx.xxx"
```

この `public_ip` が EC2 サーバーの IP アドレス。メモしておく。

---

## Step 4: プロビジョニング完了を待つ（約 15〜20 分）

`terraform apply` で EC2 が起動すると、`user-data.sh`（cloud-init）が自動で実行される。
このスクリプトが以下を全て自動インストールする:

1. Xvfb, Mesa (ソフトウェア OpenGL), FFmpeg, Docker, Java, Node.js, etc.
2. VOICEVOX（Docker コンテナ）
3. Minecraft Server + Minecraft Client（Fabric + Sodium mod）
4. アプリコードの git clone + ビルド

**再起動は不要（GPU 不要構成）。約 10〜15 分で完了。**

---

## Step 5: SSH 接続して動作確認

### 5-1. SSH 接続

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@<Step 3 で取得した public_ip>
```

例:
```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@13.231.xxx.xxx
```

### 5-2. プロビジョニング完了を確認

```bash
# 完了フラグの確認
ls -la ~/.provisioning-done

# ファイルが存在すれば完了。なければまだ実行中なので待つ。
# 進行状況を見たい場合:
tail -f /var/log/ai-minecraft-provision.log
```

### 5-3. 各コンポーネントの動作確認

```bash
# Minecraft Server が動いているか
sudo systemctl status minecraft-server

# VOICEVOX が動いているか
curl -s http://localhost:50021/version

# Xvfb が動いているか
sudo systemctl status xvfb

# Node.js バージョン
node --version

# アプリがビルドされているか
ls ~/ai-minecraft/dist/
```

全て問題なければ環境構築は完了。

---

## Step 6: YouTube API の準備（Google Cloud Console）

YouTube で自動配信するために、YouTube Data API の認証情報を作る。

### 6-1. Google Cloud プロジェクト作成

1. https://console.cloud.google.com/ にアクセス
2. 画面上部の「プロジェクトを選択」→「新しいプロジェクト」
3. プロジェクト名: `ai-minecraft`（任意）→ 作成

### 6-2. YouTube Data API v3 を有効化

1. 左メニュー「API とサービス」→「ライブラリ」
2. `YouTube Data API v3` を検索 → クリック → **「有効にする」**

### 6-3. OAuth 同意画面の設定

1. 左メニュー「API とサービス」→「OAuth 同意画面」
2. User Type: **外部** → 作成
3. アプリ名: `ai-minecraft`
4. ユーザーサポートメール: 自分のメール
5. デベロッパーの連絡先: 自分のメール
6. **「保存して次へ」**
7. スコープ: **「スコープを追加または削除」** → 以下を追加:
   - `https://www.googleapis.com/auth/youtube`
   - `https://www.googleapis.com/auth/youtube.upload`
8. テストユーザー: 自分の Google アカウントのメールアドレスを追加

### 6-4. OAuth クライアント ID 作成

1. 左メニュー「API とサービス」→「認証情報」
2. **「+ 認証情報を作成」** → **「OAuth クライアント ID」**
3. アプリケーションの種類: **「ウェブ アプリケーション」**
4. 名前: `ai-minecraft`
5. **承認済みのリダイレクト URI**: `http://localhost:3456/callback` を追加
6. **「作成」**

表示される **クライアント ID** と **クライアントシークレット** をメモ。

---

## Step 7: YouTube OAuth トークン取得（ローカル PC）

ローカル PC（ブラウザが使える環境）で実行する。
EC2 ではなくローカルで実行する理由: ブラウザで Google ログインが必要なため。

```bash
cd ai-minecraft

# Step 6-4 でメモしたクライアント ID とシークレットを設定
export YT_CLIENT_ID="xxxxxxxxxxxx.apps.googleusercontent.com"
export YT_CLIENT_SECRET="GOCSPX-xxxxxxxxxxxx"

# スクリプト実行
npx tsx scripts/get-youtube-token.ts
```

実行すると以下が表示される:

```
=== YouTube OAuth トークン取得ツール ===

以下の URL をブラウザで開いて Google 認証を行ってください:

https://accounts.google.com/o/oauth2/v2/auth?client_id=...&...

コールバック待機中... (http://localhost:3456/callback)
```

1. 表示された URL をブラウザで開く
2. Google アカウントでログイン
3. アクセスを許可
4. ブラウザに「認証成功！」と表示される
5. ターミナルに `YOUTUBE_REFRESH_TOKEN=1//xxxxxx` が表示される

この **YOUTUBE_REFRESH_TOKEN** の値をメモ。

---

## Step 8: EC2 の .env に YouTube 情報を設定

EC2 に SSH 接続して `.env` を編集する。

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@<public_ip>
```

```bash
nano ~/ai-minecraft/.env
```

以下の項目を埋める:

```env
# Step 6-4 の値
YOUTUBE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxx

# Step 7 で取得した値
YOUTUBE_REFRESH_TOKEN=1//xxxxxxxxxxxxxxxx

# 自分の YouTube チャンネル ID
# YouTube Studio → 設定 → チャンネル → 「チャンネル ID」 で確認
YOUTUBE_CHANNEL_ID=UCxxxxxxxxxxxxxxxx
```

> **YouTube チャンネル ID の確認方法:**
> 1. https://studio.youtube.com/ にアクセス
> 2. 左下「設定」→「チャンネル」→「基本情報」
> 3. 「チャンネル URL」に含まれる `UC...` がチャンネル ID

保存して閉じる（nano: `Ctrl+O` → `Enter` → `Ctrl+X`）。

---

## Step 9: 配信テスト（MANUAL モード）

### 9-1. MANUAL モードの確認

`.env` に以下が設定されていること:

```env
OPERATION_MODE=MANUAL
```

**MANUAL モード** = 手動で配信を開始し、Minecraft で死亡したら配信終了してそこで停止。
（自動で次の配信を開始しない。テスト向き。）

### 9-2. orchestrator を起動

```bash
# systemd で起動
sudo systemctl start orchestrator

# ログをリアルタイムで確認
journalctl -u orchestrator -f
```

### 9-3. ダッシュボードから配信開始

ローカル PC からダッシュボードにアクセスするため、SSH トンネルを開く。
（EC2 のポート 8080 はインターネットに公開していないため、SSH 経由で接続する）

**ローカル PC の別のターミナルで:**

```bash
ssh -L 8080:localhost:8080 -i ~/.ssh/id_ed25519 ubuntu@<public_ip>
```

ブラウザで http://localhost:8080 を開く。

ダッシュボード画面で:
- 現在の状態が `IDLE` であることを確認
- **「配信開始」ボタン** を押す

### 9-4. YouTube で確認

1. https://studio.youtube.com/ を開く
2. 「コンテンツ」→「ライブ」タブ
3. 配信が作成されているか確認
4. 配信 URL をクリックして映像を確認

---

## Step 10: 監視と確認

### ログの確認

```bash
# orchestrator のログ
journalctl -u orchestrator -f

# Minecraft Server のログ
journalctl -u minecraft-server -f

# FFmpeg（配信映像）のログ
journalctl -u ffmpeg-stream -f

# 全てのサービスの状態
systemctl status minecraft-server voicevox xvfb orchestrator
```

### ダッシュボードで確認できること

- 現在の状態（BOOTING → PREPARING_STREAM → LIVE_RUNNING）
- 現在の世代番号
- 最高生存記録
- 最近の行動ログ
- 死亡履歴

### 配信テスト後の停止

ダッシュボードの **「配信停止」ボタン** を押す。
または:

```bash
sudo systemctl stop orchestrator
```

---

## Step 11: AUTO モードへの切り替え（本番運用）

テストが問題なければ 24 時間自動モードに切り替え。

```bash
# EC2 上で
nano ~/ai-minecraft/.env
```

```env
OPERATION_MODE=AUTO
```

```bash
sudo systemctl restart orchestrator
```

**AUTO モード** = 死亡後に自動で次の世代を開始し、新しい配信を作成する。
クールダウン（60 秒）後に自動再開。1 日の配信上限（デフォルト 20 回）に達したら翌日まで休止。

---

## 付録: コスト管理

### インスタンスの停止（課金を止めたいとき）

```bash
# EC2 を停止（データは保持される）
aws ec2 stop-instances --instance-ids <instance_id>

# 再開するとき
aws ec2 start-instances --instance-ids <instance_id>
```

> 停止中は EC2 の時間課金は止まるが、EBS（ディスク）と Elastic IP の料金は微小にかかる。

### 環境を完全に削除

```bash
cd ai-minecraft/infra
terraform destroy
```

`yes` と入力すると全リソースが削除される。**データも全て消える**ので注意。

### コスト目安

**CPU 描画構成 (c5.xlarge):**

| リソース | 時間単価 | 月額（24h稼働） |
|---|---|---|
| c5.xlarge | ~$0.20/h | ~$144 |
| EBS 30GB gp3 | - | ~$2.4 |
| Elastic IP | - | ~$3.6 |
| S3（録画） | - | ~$2 |
| **合計** | | **~$152/月** |

テスト時は使用後にインスタンスを停止すれば時間単価分だけで済む。
GPU 上限緩和が承認されたら g4dn.xlarge（~$0.71/h）に切り替え可能。

---

## トラブルシューティング

### プロビジョニングが終わらない

```bash
# ログを確認
cat /var/log/ai-minecraft-provision.log

# cloud-init のステータス
cloud-init status
```

### SSH 接続できない

- `my_ip` が正しいか確認: `curl -s ifconfig.me`
- IP が変わった場合は `terraform.tfvars` を更新して `terraform apply`

### Minecraft Server に接続できない

```bash
# ステータス確認
sudo systemctl status minecraft-server
# ポート確認
ss -tlnp | grep 25565
```

### VOICEVOX が応答しない

```bash
# Docker コンテナ確認
docker ps
docker logs voicevox
# 再起動
docker restart voicevox
```
