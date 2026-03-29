output "instance_id" {
  description = "EC2 インスタンス ID"
  value       = aws_instance.main.id
}

output "public_ip" {
  description = "Elastic IP アドレス"
  value       = aws_eip.main.public_ip
}

output "ssh_command" {
  description = "SSH 接続コマンド"
  value       = "ssh -i <秘密鍵パス> ubuntu@${aws_eip.main.public_ip}"
}

output "dashboard_tunnel" {
  description = "ダッシュボード SSH トンネルコマンド"
  value       = "ssh -L 8080:localhost:8080 -i <秘密鍵パス> ubuntu@${aws_eip.main.public_ip}"
}

output "s3_bucket" {
  description = "録画保存用 S3 バケット名"
  value       = aws_s3_bucket.recordings.id
}
