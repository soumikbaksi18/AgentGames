#!/usr/bin/env bash
# Pull-based continuous deployment. Runs as root every minute (systemd timer).
#   1. fetch origin/main (public repo: no credentials needed)
#   2. if new commit: build it in a fresh release dir, run unit tests + harness
#   3. only if everything passes: atomically switch /opt/agent/app, restart,
#      health-check; roll back to the previous release if the health check fails
# Runtime state (/opt/agent/data) and secrets (/etc/agentgames/agent.env) are
# never touched.
set -euo pipefail
REPO_URL="${REPO_URL:-https://github.com/soumikbaksi18/AgentGames.git}"
BASE=/opt/agent
REPO=$BASE/repo
RELEASES=$BASE/releases
STATE=$BASE/deploy-state
LOCK=/run/agent-autodeploy.lock
mkdir -p "$RELEASES" "$STATE"
exec 9>"$LOCK"; flock -n 9 || exit 0

log() { echo "[autodeploy] $*"; }

if [ ! -d "$REPO/.git" ]; then git clone --quiet "$REPO_URL" "$REPO"; fi
git -C "$REPO" fetch --quiet origin main
SHA=$(git -C "$REPO" rev-parse origin/main)
CURRENT=$(cat "$STATE/deployed-sha" 2>/dev/null || true)
FAILED=$(cat "$STATE/failed-sha" 2>/dev/null || true)
[ "$SHA" = "$CURRENT" ] && exit 0
[ "$SHA" = "$FAILED" ] && exit 0   # don't rebuild a known-bad commit every minute

log "new commit ${SHA:0:7} (current ${CURRENT:0:7})"
REL=$RELEASES/$SHA
rm -rf "$REL"; mkdir -p "$REL"
git -C "$REPO" archive "$SHA" | tar -x -C "$REL"

fail() { log "FAILED at: $1 — keeping ${CURRENT:0:7}"; echo "$SHA" > "$STATE/failed-sha"; rm -rf "$REL"; exit 1; }

cd "$REL"
npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || fail "npm ci"
npm run --silent build >/dev/null 2>&1               || fail "build"
npm test >"$STATE/last-test.log" 2>&1               || fail "unit tests (see $STATE/last-test.log)"
npm run --silent harness >"$STATE/last-harness.log" 2>&1 || fail "harness (see $STATE/last-harness.log)"
npm prune --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || true
chown -R agent:agent "$REL"

# Infra files shipped in the repo (only reloaded when they change).
AGENT_HOST=$(cat "$STATE/agent-host")
if ! cmp -s deploy/agent.service /etc/systemd/system/agent.service; then
  cp deploy/agent.service /etc/systemd/system/agent.service; systemctl daemon-reload; log "agent.service updated"
fi
sed "s/__AGENT_HOST__/${AGENT_HOST}/" deploy/Caddyfile > /tmp/Caddyfile.new
if ! cmp -s /tmp/Caddyfile.new /etc/caddy/Caddyfile; then
  caddy validate --config /tmp/Caddyfile.new --adapter caddyfile >/dev/null 2>&1 && \
    cp /tmp/Caddyfile.new /etc/caddy/Caddyfile && systemctl reload caddy && log "Caddyfile updated"
fi

PREV=$(readlink -f "$BASE/app" 2>/dev/null || true)
ln -sfn "$REL" "$BASE/app.next" && mv -Tf "$BASE/app.next" "$BASE/app"
systemctl restart agent

healthy=0
for _ in $(seq 1 20); do
  sleep 1
  if curl -fsS -m 2 http://127.0.0.1:8080/health >/dev/null 2>&1; then healthy=1; break; fi
done
if [ "$healthy" != 1 ]; then
  log "health check failed — rolling back"
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then ln -sfn "$PREV" "$BASE/app.next" && mv -Tf "$BASE/app.next" "$BASE/app"; systemctl restart agent; fi
  echo "$SHA" > "$STATE/failed-sha"; exit 1
fi

echo "$SHA" > "$STATE/deployed-sha"; rm -f "$STATE/failed-sha"
# Self-update the deploy script and timer from the release.
install -m 755 deploy/autodeploy.sh /usr/local/bin/agent-autodeploy
log "deployed ${SHA:0:7}"

# Keep the 3 newest releases (plus whatever is live).
LIVE=$(readlink -f "$BASE/app")
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +4 | while read -r d; do
  [ "$(readlink -f "$d")" = "$LIVE" ] || rm -rf "$d"
done
