output "api_url" {
  value = module.api.api_url
}

output "demo_target_url" {
  value = "http://${module.compute.demo_target_ip}:4000/api/users"
}

output "data_bucket" {
  value = local.data_bucket
}

output "ecr_repository_url" {
  value = module.ecr.repository_url
}

output "worker_groups" {
  value = module.compute.asg_names
}

output "alerts_topic_arn" {
  value = module.monitoring.alerts_topic_arn
}

output "team_a_key" {
  value     = random_password.team_key["team-a"].result
  sensitive = true
}

output "team_b_key" {
  value     = random_password.team_key["team-b"].result
  sensitive = true
}
