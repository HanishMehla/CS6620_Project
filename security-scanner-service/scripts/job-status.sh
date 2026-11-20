#!/bin/bash
# Check a job status in DynamoDB. Usage: scripts/job-status.sh <team-id> <job-id>
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <team-id> <job-id>" >&2
  exit 1
fi

team="$1"
job="$2"

if [[ ! "$team" =~ ^[a-z0-9-]+$ || ! "$job" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "team-id must be lowercase letters, digits and dashes, and job-id must be a UUID" >&2
  exit 1
fi

aws dynamodb get-item --region us-east-1 --table-name scanner-jobs \
  --key "{\"teamId\":{\"S\":\"$team\"},\"jobId\":{\"S\":\"$job\"}}" \
  --query 'Item' --output json
