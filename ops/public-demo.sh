#!/usr/bin/env bash
# Expose AgentGuard API (:8787) + dashboard (:3000) at free public HTTPS URLs, no account.
# Default tunnel: runlocal.eu (WebSocket over 443). Alt: TUNNEL=cloudflared (needs outbound :7844).
# URLs are random and change whenever this script runs. Secrets stay in this process env;
# only the fixed HTTP routes are served (dashboard serves dashboard/public only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; RUN=/tmp/agentguard-demo; mkdir -p $RUN
TUNNEL=${TUNNEL:-runlocal}
pkill -f "agentguard/agent/server.js" || true; pkill -f "agentguard/dashboard/dev.js" || true
pkill -f "runlocal (8787|3000)" || true; pkill -f "cloudflared tunnel --no-autoupdate --url" || true; sleep 1
PORT=8787 nohup node "$ROOT/agent/server.js" > $RUN/api.log 2>&1 < /dev/null &
PORT=3000 AG_API_URL=http://localhost:8787 nohup node "$ROOT/dashboard/dev.js" > $RUN/dash.log 2>&1 < /dev/null &
if [ "$TUNNEL" = cloudflared ]; then
  CF=${CLOUDFLARED:-$HOME/bin/cloudflared}; RE='https://[a-z0-9-]*\.trycloudflare\.com'
  nohup $CF tunnel --no-autoupdate --url http://localhost:8787 > $RUN/t-api.log 2>&1 < /dev/null &
  nohup $CF tunnel --no-autoupdate --url http://localhost:3000 > $RUN/t-dash.log 2>&1 < /dev/null &
else
  [ -x /tmp/rl/node_modules/.bin/runlocal ] || npm i --prefix /tmp/rl runlocal >/dev/null
  RE='https://[a-z0-9-]*\.runlocal\.eu'
  nohup /tmp/rl/node_modules/.bin/runlocal 8787 > $RUN/t-api.log 2>&1 < /dev/null &
  nohup /tmp/rl/node_modules/.bin/runlocal 3000 > $RUN/t-dash.log 2>&1 < /dev/null &
fi
for i in $(seq 1 30); do
  A=$(grep -o "$RE" $RUN/t-api.log | head -1 || true); D=$(grep -o "$RE" $RUN/t-dash.log | head -1 || true)
  [ -n "$A" ] && [ -n "$D" ] && break; sleep 1; done
printf 'API=%s\nDASHBOARD=%s\n' "$A" "$D" | tee $RUN/urls.env
