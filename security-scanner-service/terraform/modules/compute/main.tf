variable "vpc_id" { type = string }
variable "public_subnet_id" { type = string }
variable "sast_subnet_id" { type = string }
variable "pentest_subnet_id" { type = string }
variable "nat_public_ip" { type = string }
variable "instance_profile_name" { type = string }
variable "worker_image" { type = string }
variable "registry" { type = string }
variable "region" { type = string }
variable "bucket" { type = string }
variable "jobs_table" { type = string }
variable "queue_urls" { type = map(string) }
variable "demo_target_script" { type = string }
variable "max_workers" { type = number }

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  ami = nonsensitive(data.aws_ssm_parameter.al2023.value)
  pools = {
    sast    = var.sast_subnet_id
    pentest = var.pentest_subnet_id
  }
}

resource "aws_cloudwatch_log_group" "workers" {
  name              = "/scanner/workers"
  retention_in_days = 7
}

# No inbound rules, Workers only pull from SQS.
resource "aws_security_group" "worker" {
  name   = "scanner-worker-sg"
  vpc_id = var.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_launch_template" "worker" {
  for_each               = local.pools
  name                   = "scanner-${each.key}-worker"
  image_id               = local.ami
  instance_type          = "t3.small"
  vpc_security_group_ids = [aws_security_group.worker.id]

  iam_instance_profile {
    name = var.instance_profile_name
  }

  # hop limit 2 lets the container fetch role credentials
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  user_data = base64encode(templatefile("${path.module}/worker-user-data.sh.tpl", {
    pool         = each.key
    worker_image = var.worker_image
    registry     = var.registry
    region       = var.region
    bucket       = var.bucket
    jobs_table   = var.jobs_table
    queue_url    = var.queue_urls[each.key]
    log_group    = aws_cloudwatch_log_group.workers.name
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "scanner-${each.key}-worker", Pool = each.key }
  }
}

resource "aws_autoscaling_group" "worker" {
  for_each            = local.pools
  name                = "scanner-${each.key}-workers"
  vpc_zone_identifier = [each.value]
  min_size            = 1
  max_size            = var.max_workers
  desired_capacity    = 1


  enabled_metrics = ["GroupInServiceInstances", "GroupDesiredCapacity"]

  lifecycle {
    ignore_changes = [desired_capacity]
  }

  launch_template {
    id      = aws_launch_template.worker[each.key].id
    version = aws_launch_template.worker[each.key].latest_version
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 0
    }
  }
}

# Only the NAT gateway IP can reach port 4000
resource "aws_security_group" "demo_target" {
  name   = "scanner-demo-target-sg"
  vpc_id = var.vpc_id
  ingress {
    from_port   = 4000
    to_port     = 4000
    protocol    = "tcp"
    cidr_blocks = ["${var.nat_public_ip}/32"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "demo_target" {
  ami                    = local.ami
  instance_type          = "t3.micro"
  subnet_id              = var.public_subnet_id
  vpc_security_group_ids = [aws_security_group.demo_target.id]
  iam_instance_profile   = var.instance_profile_name

  metadata_options {
    http_tokens = "required"
  }

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/target-user-data.sh.tpl", {
    script = var.demo_target_script
  })

  tags = { Name = "scanner-demo-target" }
}

output "asg_names" { value = { for k, g in aws_autoscaling_group.worker : k => g.name } }
output "demo_target_ip" { value = aws_instance.demo_target.public_ip }
