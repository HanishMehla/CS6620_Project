variable "region" {
  type    = string
  default = "us-east-1"
}

variable "lab_instance_profile_name" {
  description = "Existing instance profile for the EC2 workers (Learner Lab can't create one)"
  type        = string
  default     = "LabInstanceProfile"
}

variable "image_tag" {
  description = "Worker image tag in ECR. scripts/push-image.sh tags the image with the git commit SHA."
  type        = string
}

variable "max_workers_per_pool" {
  description = "Most workers each scan type can scale to"
  type        = number
  default     = 3
}
