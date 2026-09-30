#!/usr/bin/env bash
# Copies the working tree to the Windows checkout that actually runs the stack.
#
#   scripts/sync-windows.sh            WSL repo -> C:\Users\<user>\photoshop-ai-studio
#
# Why this exists: Photoshop only runs on Windows, so the stack runs there, but
# git and the shell live here. Two copies, one of them the thing that runs.
#
# The exclusions are load-bearing, not tidiness:
#
#   node_modules  rebuilt by `npm install` on Windows, which resolves optional
#                 native dependencies for the host instead of the WSL one
#   dist          built by `npm run build` on Windows from whatever is synced
#   .env          machine-local and gitignored. This file carries
#                 WORKSPACE_ROOT=/mnt/c/... which is meaningless to Windows and
#                 silently turns every path into C:\mnt\c\...
#   logs, data    runtime state; the copy that runs owns its own
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WIN_USER="${WIN_USER:-$(powershell.exe -NoProfile -Command '$env:USERNAME' 2>/dev/null | tr -d '\r')}"
WIN_USER="${WIN_USER:-$USER}"
DEST="C:\\Users\\${WIN_USER}\\photoshop-ai-studio"

if [ ! -d "$DEST" ]; then
  echo "no Windows checkout at $DEST — create it first" >&2
  exit 1
fi

# Probes and scratch files this debugging leaves in data/; they are not source.
SCRATCH=(
  '*.pid' 'probe-args.json' 'run29.json' 'probes.jsonl' 'caps.json'
  'mv.jsonl' 'mv2.jsonl' 'crop.jsonl' 'place.jsonl' 'lifecycle.jsonl'
  'demo-body.json' 'demo29.json' 'demo-run.txt'
)

powershell.exe -NoProfile -Command "
  robocopy '\\\\wsl.localhost\\$(cd / && echo "${WSL_DISTRO_NAME:-Debian}" | tr -d '\r')'\\home\\${USER}\\photoshop-ai-studio' '$DEST' /E \
    /XD node_modules dist logs coverage .turbo .git \
    ${SCRATCH[*]@/ /XF } \
    /NFL /NDL /NP | Out-Null
  # 0-7 are success; 8+ means robocopy itself failed.
  if (\$LASTEXITCODE -ge 8) { exit \$LASTEXITCODE }
  exit 0
" || { echo "robocopy failed" >&2; exit 1; }

echo "synced $REPO -> $DEST"
echo "next: cd /d $DEST && npm install && npm run build"