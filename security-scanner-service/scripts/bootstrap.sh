#!/bin/bash
# Run once per AWS account before first terraform init.
# Creates two S3 buckets and writes terraform/backend.hcl.
set -euo pipefail
cd "$(dirname "$0")/../terraform"

region="us-east-1"
account="$(aws sts get-caller-identity --query Account --output text)"

make_private_bucket() {
  local bucket="$1"
  if aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
    echo "Bucket $bucket already exists"
    return
  fi
  aws s3api create-bucket --bucket "$bucket" --region "$region"
  aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
  echo "Created bucket $bucket"
}

make_private_bucket "scanner-tfstate-$account"
aws s3api put-bucket-versioning --bucket "scanner-tfstate-$account" \
  --versioning-configuration Status=Enabled
make_private_bucket "scanner-data-$account"

printf 'bucket = "%s"\n' "scanner-tfstate-$account" > backend.hcl
echo "Wrote terraform/backend.hcl. Next: terraform init -backend-config=backend.hcl"
