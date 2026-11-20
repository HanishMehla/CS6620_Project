#!/bin/bash
# Builds and pushes the worker image to ECR.
# ECR repo must exist first: terraform apply -target=module.ecr -var="image_tag=none"
set -euo pipefail
cd "$(dirname "$0")/.."

region="us-east-1"
tag="$(git rev-parse --short=12 HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
repo="$(aws ecr describe-repositories --repository-names scanner-worker --region "$region" \
  --query 'repositories[0].repositoryUri' --output text)"
registry="${repo%%/*}"

aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"
docker build --tag "$repo:$tag" backend/worker
docker push "$repo:$tag"

echo "Pushed $repo:$tag"
echo "Deploy it with: terraform apply -var=\"image_tag=$tag\""
