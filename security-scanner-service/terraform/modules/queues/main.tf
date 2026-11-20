# One queue per scan type, so slow pentests never hold up quick SAST scans.
# Both share one dead-letter queue.
locals {
  scan_types = toset(["sast", "pentest"])
}

resource "aws_sqs_queue" "dead_letter" {
  name                      = "scanner-dead-letter"
  message_retention_seconds = 1209600 # 14 days, the maximum
}

resource "aws_sqs_queue" "jobs" {
  for_each                   = local.scan_types
  name                       = "scanner-${each.key}-jobs"
  visibility_timeout_seconds = 300
  receive_wait_time_seconds  = 20
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = 3
  })
}

output "queue_urls" { value = { for k, q in aws_sqs_queue.jobs : k => q.url } }
output "dead_letter_name" { value = aws_sqs_queue.dead_letter.name }
output "queue_names" { value = { for k, q in aws_sqs_queue.jobs : k => q.name } }
