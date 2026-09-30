#!/usr/bin/env bash
# Install the plugin, restart Photoshop, and wait for the plugin to reconnect.
#
# UXP loads plugin JavaScript into the host at startup, so a plugin change needs a
# Photoshop restart (the UXP Developer Tool's Watch mode would do it live, but it
# is not installed). This is the loop every plugin fix goes through.
#
#   scripts/reload-plugin.sh          install + restart + wait for hello
#   scripts/reload-plugin.sh --build  rebuild the Node services first
set -euo pipefail
cd "$(dirname "$0")/.."

PHOTOSHOP_EXE='C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe'
LOG=logs/mcp.log

if [ "${1:-}" = "--build" ]; then
  echo "building…"
  npm run build >/dev/null
fi

echo "installing the plugin…"
./scripts/install-plugin.sh >/dev/null

before=$(wc -l < "$LOG" 2>/dev/null || echo 0)

echo "restarting Photoshop…"
powershell.exe -NoProfile -Command "
Stop-Process -Name Photoshop -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-Process -FilePath '${PHOTOSHOP_EXE}'
" 2>/dev/null | tr -d '\r'

printf "waiting for the plugin to connect"
for _ in $(seq 1 60); do
  sleep 2
  if tail -n +"$before" "$LOG" 2>/dev/null | grep -qa "Connected to"; then
    echo ""
    tail -n +"$before" "$LOG" | grep -a "Connected to" | tail -1
    exit 0
  fi
  printf "."
done

echo ""
echo "the plugin did not connect within 120s"
echo "--- bridge log tail ---"
tail -n 20 "$LOG"
exit 1
