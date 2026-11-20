# CloudWatch alarms that scale the workers and watch for problems.
variable "queue_names" { type = map(string) }
variable "dead_letter_name" { type = string }
variable "asg_names" { type = map(string) }

resource "aws_sns_topic" "alerts" {
  name = "scanner-alerts"
}

resource "aws_autoscaling_policy" "scale_out" {
  for_each               = var.asg_names
  name                   = "scanner-${each.key}-scale-out"
  autoscaling_group_name = each.value
  adjustment_type        = "ChangeInCapacity"
  scaling_adjustment     = 1
  cooldown               = 180
}

resource "aws_autoscaling_policy" "scale_in" {
  for_each               = var.asg_names
  name                   = "scanner-${each.key}-scale-in"
  autoscaling_group_name = each.value
  adjustment_type        = "ChangeInCapacity"
  scaling_adjustment     = -1
  cooldown               = 300
}

resource "aws_cloudwatch_metric_alarm" "backlog" {
  for_each            = var.queue_names
  alarm_name          = "scanner-${each.key}-backlog"
  alarm_description   = "Jobs are waiting in the ${each.key} queue"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_autoscaling_policy.scale_out[each.key].arn, aws_sns_topic.alerts.arn]
}

# in-flight messages count too, so a worker mid-scan is never removed
resource "aws_cloudwatch_metric_alarm" "idle" {
  for_each            = var.queue_names
  alarm_name          = "scanner-${each.key}-idle"
  alarm_description   = "The ${each.key} queue is empty and no scan is running"
  evaluation_periods  = 10
  comparison_operator = "LessThanOrEqualToThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_autoscaling_policy.scale_in[each.key].arn]

  metric_query {
    id          = "total"
    expression  = "waiting + running"
    label       = "Jobs waiting or running"
    return_data = true
  }
  metric_query {
    id = "waiting"
    metric {
      namespace   = "AWS/SQS"
      metric_name = "ApproximateNumberOfMessagesVisible"
      dimensions  = { QueueName = each.value }
      stat        = "Maximum"
      period      = 60
    }
  }
  metric_query {
    id = "running"
    metric {
      namespace   = "AWS/SQS"
      metric_name = "ApproximateNumberOfMessagesNotVisible"
      dimensions  = { QueueName = each.value }
      stat        = "Maximum"
      period      = 60
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "dead_letter" {
  alarm_name          = "scanner-dead-letter-not-empty"
  alarm_description   = "A job failed 3 times and is in the dead-letter queue"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = var.dead_letter_name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "no_workers" {
  for_each            = var.asg_names
  alarm_name          = "scanner-${each.key}-no-workers"
  alarm_description   = "No ${each.key} worker is in service"
  namespace           = "AWS/AutoScaling"
  metric_name         = "GroupInServiceInstances"
  dimensions          = { AutoScalingGroupName = each.value }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_autoscaling_notification" "workers" {
  group_names = values(var.asg_names)
  topic_arn   = aws_sns_topic.alerts.arn
  notifications = [
    "autoscaling:EC2_INSTANCE_LAUNCH",
    "autoscaling:EC2_INSTANCE_TERMINATE",
    "autoscaling:EC2_INSTANCE_LAUNCH_ERROR",
  ]
}

output "alerts_topic_arn" { value = aws_sns_topic.alerts.arn }
