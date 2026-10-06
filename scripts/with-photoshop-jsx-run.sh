#!/usr/bin/env bash
# Runs an arbitrary .jsx file in the running Photoshop through COM automation.
#
# COM is used rather than `Photoshop.exe -r` because `-r` is undocumented and
# shows a trust dialog; `Photoshop.Application.DoJavaScriptFile` attaches to the
# already-running instance and does not.
#
#   scripts/with-photoshop-jsx-run.sh scripts/probe-brush-dom.jsx
#
# ## Warnings, both learned the hard way
#
# 1. **Resolve the profile directory, not `$env:USERNAME`.** The two can differ,
#    and when they do every path built from the username points at a directory
#    that does not exist and Photoshop fails with "expected a reference to an
#    existing file" — a message that reads like a permissions problem and is not
#    one. `$env:USERPROFILE` is the directory; `$env:USERNAME` is only a name.
# 2. **A modal dialog raised from inside the script wedges the channel.** The
#    script never returns, and every later `DoJavaScript` fails with
#    RPC_E_SERVERCALL_RETRYLATER until the dialog is dismissed by hand. The
#    scripts in this directory are written not to close documents for that
#    reason — see the header of probe-brush-dom.jsx.
#
# Output is the script's last expression. Non-ASCII is escaped by the scripts
# themselves, because the host returns messages in the system codepage.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $(basename "$0") <script.jsx>" >&2
  exit 2
fi

SOURCE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[ -f "$SOURCE" ] || { echo "no such file: $SOURCE" >&2; exit 2; }

# USERPROFILE, not USERNAME — see warning 1 above.
WIN_PROFILE="$(powershell.exe -NoProfile -Command '$env:USERPROFILE' 2>/dev/null | tr -d '\r')"
# Convert C:\\Users\\maxim to /mnt/c/Users/maxim for the WSL side.
DRIVE_LETTER="$(printf '%s' "$WIN_PROFILE" | cut -c1 | tr '[:upper:]' '[:lower:]')"
REST="$(printf '%s' "$WIN_PROFILE" | cut -c3- | tr '\\' '/')"
STAGE_DIR="/mnt/${DRIVE_LETTER}${REST}/AppData/Local/Temp"
[ -d "$STAGE_DIR" ] || { echo "staging directory not visible from WSL: $STAGE_DIR" >&2; exit 1; }

STAGED="$STAGE_DIR/studio-$(basename "$1")"
cp "$SOURCE" "$STAGED"

# The path Photoshop needs is the Windows one, not the WSL mount: /mnt/c/... and
# C:\... are the same bytes on disk but only the latter resolves inside the host.
STAGED_WIN="${WIN_PROFILE}\\AppData\\Local\\Temp\\studio-$(basename "$1")"

powershell.exe -NoProfile -Command "
[Console]::OutputEncoding = [Text.Encoding]::UTF8
\$ps = New-Object -ComObject Photoshop.Application
try {
  \$result = \$ps.DoJavaScriptFile('${STAGED_WIN}', @(), 1)
  Write-Output \$result
} catch {
  Write-Output ('FAILED: ' + \$_.Exception.Message)
  exit 1
}
" 2>&1 | tr -d '\r'