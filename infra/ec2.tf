# --- データソース ---

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# --- SSH キーペア ---

resource "aws_key_pair" "main" {
  key_name   = "${var.project_name}-key"
  public_key = file(var.ssh_public_key_path)
}

# --- Security Group ---

resource "aws_security_group" "main" {
  name        = "${var.project_name}-sg"
  description = "AI Minecraft - SSH only inbound"

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.my_ip]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- EC2 インスタンス ---

resource "aws_instance" "main" {
  ami                  = data.aws_ami.ubuntu.id
  instance_type        = var.instance_type
  key_name             = aws_key_pair.main.key_name
  iam_instance_profile = aws_iam_instance_profile.ec2.name

  vpc_security_group_ids = [aws_security_group.main.id]

  root_block_device {
    volume_size           = var.root_volume_size
    volume_type           = "gp3"
    delete_on_termination = true
    encrypted             = true
  }

  user_data = templatefile("${path.module}/scripts/user-data.sh", {
    github_repo       = var.github_repo
    anthropic_api_key = var.anthropic_api_key
    minecraft_version = var.minecraft_version
    s3_bucket         = aws_s3_bucket.recordings.id
    aws_region        = var.region
  })

  metadata_options {
    http_tokens = "required" # IMDSv2 強制
  }

  monitoring = true

  tags = {
    Name = var.project_name
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

# --- Elastic IP ---

resource "aws_eip" "main" {
  domain = "vpc"

  tags = {
    Name = "${var.project_name}-eip"
  }
}

resource "aws_eip_association" "main" {
  instance_id   = aws_instance.main.id
  allocation_id = aws_eip.main.id
}
