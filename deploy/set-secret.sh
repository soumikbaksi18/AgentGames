#!/usr/bin/env bash
# Run this in YOUR OWN terminal (not in an AI chat). It prompts for a secret
# with hidden input and writes it to /etc/agentgames/agent.env on the server
# (root-only, chmod 600), then restarts the agent. Nothing is echoed or logged.
#
#   SSH_KEY=~/.ssh/agentgames-gatekeeper.pem AGENT_IP=3.6.185.54 deploy/set-secret.sh AGENT_GAMES_HMAC_SECRET
#   SSH_KEY=... AGENT_IP=... deploy/set-secret.sh KURIER_API_KEY
set -euo pipefail
: "${SSH_KEY:?set SSH_KEY}"; : "${AGENT_IP:?set AGENT_IP}"
NAME="${1:?usage: set-secret.sh <AGENT_GAMES_HMAC_SECRET|KURIER_API_KEY>}"
case "$NAME" in AGENT_GAMES_HMAC_SECRET|KURIER_API_KEY) ;; *) echo "unsupported name"; exit 1;; esac
read -r -s -p "Paste value for $NAME (hidden): " VALUE; echo
[ -n "$VALUE" ] || { echo "empty value, aborting"; exit 1; }
# Value travels over the encrypted SSH channel via stdin, never as an argument.
printf '%s' "$VALUE" | ssh -i "$SSH_KEY" "ubuntu@${AGENT_IP}" "sudo NAME=$NAME bash -c '
  set -euo pipefail; V=\$(cat); F=/etc/agentgames/agent.env
  touch \$F; chmod 600 \$F
  grep -v \"^\$NAME=\" \$F > \$F.tmp || true
  printf \"%s=%s\n\" \"\$NAME\" \"\$V\" >> \$F.tmp; mv \$F.tmp \$F; chmod 600 \$F
  systemctl restart agent; sleep 1; systemctl is-active agent'"
unset VALUE
echo "$NAME set on server and agent restarted."
