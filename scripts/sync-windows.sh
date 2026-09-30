#!/usr/bin/env bash
# Copies the working tree to the Windows checkout that actually runs the stack.
#
#   scripts/sync-windows.sh            WSL repo -> C:\Users\<user>\photoshop-ai-studio
#
# Why this exists: Photoshop only runs on Windows, so the stack runs there, but
# git and the shell live here. Two copies, one of them the thing that runs.
#
# robocopy.exe is invoked directly rather than through PowerShell. Copying with
# `cp` from WSL looks like it works and silently does not, because a stale DrvFs
# dentry can leave the destination unchanged — which is how the plugin kept
# running code from an hour-old build while the installer reported success.
# robocopy reads the source through the UNC path every time and tells you its
# exit code.
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
# `wslpath -w` derives the UNC path from where this repo actually is. Spelling it
# out by hand put the source at \home\<user>\photoshop-ai-studio, one directory
# too high, and robocopy reported success while copying nothing.
SOURCE="$(wslpath -w "$REPO")"
DEST="C:\\Users\\${WIN_USER}\\photoshop-ai-studio"

# Probes and scratch files this debugging leaves in data/; they are not source.
SCRATCH=(
  '.env'
  '*.pid' 'probe-args.json' 'run29.json' 'probes.jsonl' 'caps.json' 'a.json'
  '*.jsonl' 'demo-body.json' 'demo29.json' 'demo-run.txt'
)

# Probed through PowerShell: a Windows path is not a path bash can stat.
if [ "$(powershell.exe -NoProfile -Command "if (Test-Path '$DEST') { 'yes' }" 2>/dev/null | tr -d '\r')" != 'yes' ]; then
  echo "no Windows checkout at $DEST - create it first" >&2
  exit 1
fi

set +e
robocopy.exe "$SOURCE" "$DEST" /E \
  /XD node_modules dist logs coverage .turbo .git \
  /XF "${SCRATCH[@]}" \
  /NFL /NDL /NP > /dev/null
code=$?
set -e

# robocopy's exit code is a bitmask, not a status: 1 = files copied,
# 2 = extras, 4 = mismatched, 8 = files failed, 16 = files excluded. The filters
# below always exclude something, so 16 is routine; treating ">= 8" as failure
# made a clean sync look broken.
if [ $((code & 8)) -ne 0 ]; then
  echo "robocopy could not copy every file (exit $code)" >&2
  exit 1
fi

echo "synced $REPO -> $DEST"
echo "next: cd /d $DEST && npm install && npm run build"