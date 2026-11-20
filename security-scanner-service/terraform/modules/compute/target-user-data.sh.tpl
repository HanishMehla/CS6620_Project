#!/bin/bash
set -euxo pipefail
dnf install -y nodejs npm
mkdir -p /opt/target && cd /opt/target
cat > test-target.js <<'SCRIPT'
${script}
SCRIPT
echo '{"type":"module","dependencies":{"express":"^4.18.2"}}' > package.json
npm install
cat > /etc/systemd/system/demo-target.service <<'UNIT'
[Unit]
Description=Vulnerable demo API
After=network-online.target
[Service]
WorkingDirectory=/opt/target
ExecStart=/usr/bin/node test-target.js
Restart=always
User=nobody
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now demo-target
