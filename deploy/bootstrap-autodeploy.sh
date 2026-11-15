#!/usr/bin/env bash
# One-time setup of pull-based auto-deploy on the server.
#   SSH_KEY=~/.ssh/agentgames-gatekeeper.pem AGENT_IP=3.6.185.54 deploy/bootstrap-autodeploy.sh
set -euo pipefail
: "${SSH_KEY:?set SSH_KEY}"; : "${AGENT_IP:?set AGENT_IP}"
AGENT_HOST="$(echo "$AGENT_IP" | tr . -).sslip.io"
cd "$(dirname "$0")"
scp -i "$SSH_KEY" autodeploy.sh agent-autodeploy.service agent-autodeploy.timer "ubuntu@${AGENT_IP}:/tmp/"
ssh -i "$SSH_KEY" "ubuntu@${AGENT_IP}" "sudo AGENT_HOST=$AGENT_HOST bash -s" <<'REMOTE'
set -euo pipefail
mkdir -p /opt/agent/deploy-state /opt/agent/releases /opt/agent/data /etc/agentgames
echo "$AGENT_HOST" > /opt/agent/deploy-state/agent-host
[ -f /etc/agentgames/agent.env ] || printf 'AGENT_GAMES_HMAC_SECRET=\nKURIER_API_KEY=\n' > /etc/agentgames/agent.env
chmod 600 /etc/agentgames/agent.env
# Old non-symlink app dir from manual deploys -> keep as a fallback release.
if [ -d /opt/agent/app ] && [ ! -L /opt/agent/app ]; then
  rm -rf /opt/agent/releases/manual && mv /opt/agent/app /opt/agent/releases/manual
  ln -sfn /opt/agent/releases/manual /opt/agent/app
fi
rm -rf /opt/agent/app.old
install -m 755 /tmp/autodeploy.sh /usr/local/bin/agent-autodeploy
install -m 644 /tmp/agent-autodeploy.service /etc/systemd/system/agent-autodeploy.service
install -m 644 /tmp/agent-autodeploy.timer /etc/systemd/system/agent-autodeploy.timer
systemctl daemon-reload
systemctl enable --now agent-autodeploy.timer
echo "timer enabled"
REMOTE
