#!/usr/bin/env bash
# Build locally, ship to the EC2 host, restart. Secrets are NOT shipped —
# they live only in /etc/agentgames/agent.env on the server.
#
#   SSH_KEY=~/.ssh/agentgames-gatekeeper.pem AGENT_IP=3.6.185.54 deploy/deploy.sh
set -euo pipefail
: "${SSH_KEY:?set SSH_KEY}"; : "${AGENT_IP:?set AGENT_IP}"
HOST="ubuntu@${AGENT_IP}"
AGENT_HOST="$(echo "$AGENT_IP" | tr . -).sslip.io"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)
cd "$(dirname "$0")/.."

npm run build
COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/agent-release.tgz dist circuits package.json package-lock.json deploy
scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new /tmp/agent-release.tgz "$HOST:/tmp/agent-release.tgz"

"${SSH[@]}" "$HOST" "sudo AGENT_HOST=$AGENT_HOST bash -s" <<'REMOTE'
set -euo pipefail
mkdir -p /opt/agent/app /opt/agent/data /etc/agentgames
rm -rf /opt/agent/app.new && mkdir -p /opt/agent/app.new
tar xzf /tmp/agent-release.tgz -C /opt/agent/app.new
cd /opt/agent/app.new && npm ci --omit=dev --no-audit --no-fund >/dev/null
rm -rf /opt/agent/app.old; [ -d /opt/agent/app ] && mv /opt/agent/app /opt/agent/app.old
mv /opt/agent/app.new /opt/agent/app
chown -R agent:agent /opt/agent
if [ ! -f /etc/agentgames/agent.env ]; then
  printf 'AGENT_GAMES_HMAC_SECRET=\nKURIER_API_KEY=\n' | tee /etc/agentgames/agent.env >/dev/null
fi
chown root:root /etc/agentgames/agent.env && chmod 600 /etc/agentgames/agent.env
cp /opt/agent/app/deploy/agent.service /etc/systemd/system/agent.service
sed "s/__AGENT_HOST__/${AGENT_HOST}/" /opt/agent/app/deploy/Caddyfile | tee /etc/caddy/Caddyfile >/dev/null
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
systemctl daemon-reload
systemctl enable --now agent >/dev/null 2>&1 || true
systemctl restart agent
systemctl enable --now caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 2
systemctl is-active agent caddy || true
REMOTE
echo "Deployed. Endpoint: https://${AGENT_HOST}/agent"
