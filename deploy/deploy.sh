#!/usr/bin/env bash
# Deploys happen automatically: the server pulls GitHub main every minute,
# builds, runs the tests, and switches only if they pass (deploy/autodeploy.sh).
# This script just triggers that check immediately and shows the result.
#   SSH_KEY=~/.ssh/agentgames-gatekeeper.pem AGENT_IP=3.6.185.54 deploy/deploy.sh
set -euo pipefail
: "${SSH_KEY:?set SSH_KEY}"; : "${AGENT_IP:?set AGENT_IP}"
ssh -i "$SSH_KEY" "ubuntu@${AGENT_IP}" '
  sudo systemctl start agent-autodeploy.service || true
  sudo journalctl -u agent-autodeploy.service -n 15 --no-pager -o cat | grep "\[autodeploy\]" | tail -5
  echo "deployed: $(sudo cat /opt/agent/deploy-state/deployed-sha 2>/dev/null | cut -c1-7)"
  systemctl is-active agent'
