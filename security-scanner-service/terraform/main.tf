# Security Scanner Service 
# Flow: Postman -> API Gateway -> Lambda -> SQS -> EC2 workers -> S3 + DynamoDB
#
# Setup:
#   bash ../scripts/bootstrap.sh
#   terraform init -backend-config=backend.hcl
#   terraform apply -var="image_tag=<tag>"

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
    random  = { source = "hashicorp/random", version = "~> 3.0" }
  }

  backend "s3" {
    key          = "scanner/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "me" {}

locals {
  account_id = data.aws_caller_identity.me.account_id
  lab_role_arn = "arn:aws:iam::${local.account_id}:role/LabRole"
  data_bucket = "scanner-data-${local.account_id}"
}

module "network" {
  source = "./modules/network"
  region = var.region
}

module "ecr" {
  source = "./modules/ecr"
}

module "storage" {
  source = "./modules/storage"
  bucket = local.data_bucket
}

module "queues" {
  source = "./modules/queues"
}

module "api" {
  source            = "./modules/api"
  role_arn          = local.lab_role_arn
  lambda_source_dir = "${path.module}/../middleware/lamdas/submit"
  bucket            = local.data_bucket
  jobs_table        = module.storage.jobs_table
  teams_table       = module.storage.teams_table
  queue_urls        = module.queues.queue_urls
}

module "compute" {
  source                = "./modules/compute"
  vpc_id                = module.network.vpc_id
  public_subnet_id      = module.network.public_subnet_id
  sast_subnet_id        = module.network.sast_subnet_id
  pentest_subnet_id     = module.network.pentest_subnet_id
  nat_public_ip         = module.network.nat_public_ip
  instance_profile_name = var.lab_instance_profile_name
  worker_image          = "${module.ecr.repository_url}:${var.image_tag}"
  registry              = module.ecr.registry
  max_workers           = var.max_workers_per_pool
  region                = var.region
  bucket                = local.data_bucket
  jobs_table            = module.storage.jobs_table
  queue_urls            = module.queues.queue_urls
  demo_target_script    = file("${path.module}/../backend/worker/tools/pentest/backend/test-target.js")
}

module "monitoring" {
  source           = "./modules/monitoring"
  queue_names      = module.queues.queue_names
  dead_letter_name = module.queues.dead_letter_name
  asg_names        = module.compute.asg_names
}

# Two demo teams, Only the hash of each key is stored, never the key itself.
resource "random_password" "team_key" {
  for_each = toset(["team-a", "team-b"])
  length   = 32
  special  = false
}

locals {
  team_targets = {
    "team-a" = ["${module.compute.demo_target_ip}:4000"]
    "team-b" = []
  }
}

resource "aws_dynamodb_table_item" "team" {
  for_each   = local.team_targets
  table_name = module.storage.teams_table
  hash_key   = "apiKeyHash"
  item = jsonencode({
    apiKeyHash     = { S = sha256(random_password.team_key[each.key].result) }
    teamId         = { S = each.key }
    allowedTargets = { L = [for target in each.value : { S = target }] }
  })
}
