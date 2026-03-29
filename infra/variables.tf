variable "region" {
  description = "AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "instance_type" {
  description = "EC2 インスタンスタイプ (CPU描画: c5.xlarge, GPU承認後: g4dn.xlarge)"
  type        = string
  default     = "c5.xlarge"
}

variable "ssh_public_key_path" {
  description = "SSH 公開鍵ファイルのパス"
  type        = string
}

variable "my_ip" {
  description = "SSH 接続を許可する自分の IP アドレス (x.x.x.x/32)"
  type        = string
}

variable "github_repo" {
  description = "アプリケーションの GitHub リポジトリ URL"
  type        = string
  default     = "https://github.com/ikdmtm/ai-minecraft.git"
}

variable "anthropic_api_key" {
  description = "Anthropic API キー"
  type        = string
  sensitive   = true
}

variable "minecraft_version" {
  description = "Minecraft Server バージョン"
  type        = string
  default     = "1.21.4"
}

variable "root_volume_size" {
  description = "ルート EBS ボリュームサイズ (GB)"
  type        = number
  default     = 30
}

variable "project_name" {
  description = "プロジェクト名（リソース命名に使用）"
  type        = string
  default     = "ai-minecraft"
}
