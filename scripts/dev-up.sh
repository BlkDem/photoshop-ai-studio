#!/usr/bin/env bash
# Starts the stack for a Photoshop session and tails the bridge log.
#   scripts/dev-up.sh          — start in the background, print the tail
#   scripts/dev-up.sh stop     — stop
set -u
cd "$(dirname "$0")/.."

case "${1:-start}" in
  stop)
    for pattern in "[m]cp-server/dist/index.js" "[o]rchestrator/dist/index.js" "[v]ite"; do
      pkill -f "$pattern" 2>/dev/null
    done
    echo "stopped"
    exit 0
    ;;
esac

mkdir -p data logs

start() {
  local name="$1"; shift
  setsid nohup "$@" > "logs/$name.log" 2>&1 &
  echo "$!" > "data/$name.pid"
  echo "  $name pid $(cat "data/$name.pid")  -> logs/$name.log"
}

echo "building…"
npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }

start mcp          node mcp-server/dist/index.js
start orchestrator node orchestrator/dist/index.js
start studio       npm --workspace studio run dev

sleep 4
echo
echo "health:"
curl -s --max-time 5 http://127.0.0.1:3001/health | head -c 160; echo
curl -s --max-time 5 http://127.0.0.1:3003/api/health | head -c 160; echo
echo
echo "bridge log (tail -f logs/mcp.log to watch Photoshop connect):"
tail -n 5 logs/mcp.log
