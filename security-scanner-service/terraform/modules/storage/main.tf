variable "bucket" { type = string }

# Private bucket for uploaded zips and full reports. Access is only through signed links.
resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = var.bucket
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = var.bucket
  rule {
    id     = "expire-old-files"
    status = "Enabled"
    filter {}
    expiration {
      days = 30
    }
  }
}

resource "aws_dynamodb_table" "jobs" {
  name         = "scanner-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "teamId"
  range_key    = "jobId"
  attribute {
    name = "teamId"
    type = "S"
  }
  attribute {
    name = "jobId"
    type = "S"
  }
}

resource "aws_dynamodb_table" "teams" {
  name         = "scanner-teams"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "apiKeyHash"
  attribute {
    name = "apiKeyHash"
    type = "S"
  }
}

output "jobs_table" { value = aws_dynamodb_table.jobs.name }
output "teams_table" { value = aws_dynamodb_table.teams.name }
