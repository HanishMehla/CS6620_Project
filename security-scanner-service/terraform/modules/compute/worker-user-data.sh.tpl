#!/bin/bash
set -euxo pipefail
dnf install -y docker
systemctl enable --now docker

# The image may not be pushed yet when the instance boots, so keep trying.
until aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry} \
  && docker pull ${worker_image}; do
  echo "Image not ready yet, retrying in 20s"
  sleep 20
done

docker run -d --name ${pool}-worker --restart unless-stopped \
  --log-driver awslogs \
  --log-opt awslogs-region=${region} \
  --log-opt awslogs-group=${log_group} \
  --log-opt awslogs-stream=${pool}-$(cat /var/lib/cloud/data/instance-id) \
  -e AWS_REGION=${region} -e BUCKET=${bucket} -e JOBS_TABLE=${jobs_table} \
  -e QUEUE_URL="${queue_url}" ${worker_image}
