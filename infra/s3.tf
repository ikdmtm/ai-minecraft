resource "aws_s3_bucket" "recordings" {
  bucket_prefix = "${var.project_name}-recordings-"
  force_destroy = false

  tags = {
    Name = "${var.project_name}-recordings"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "recordings" {
  bucket = aws_s3_bucket.recordings.id

  rule {
    id     = "auto-delete-30d"
    status = "Enabled"

    expiration {
      days = 30
    }

    filter {
      prefix = "recordings/"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "recordings" {
  bucket = aws_s3_bucket.recordings.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "recordings" {
  bucket = aws_s3_bucket.recordings.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
