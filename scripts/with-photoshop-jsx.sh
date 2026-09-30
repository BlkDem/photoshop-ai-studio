#!/usr/bin/env bash
# Runs a .jsx file in the running Photoshop through COM automation.
#
# COM is used rather than `Photoshop.exe -r` because `-r` is undocumented and
# shows a trust dialog; `Photoshop.Application.DoJavaScriptFile` attaches to the
# already-running instance and does not.
#
#   scripts/with-photoshop.jsx-fixture.sh
set -euo pipefail
cd "$(dirname "$0")/.."

APPDATA_UXP="/mnt/c/Users/$(powershell.exe -NoProfile -Command '$env:USERNAME' 2>/dev/null | tr -d '\r')/AppData/Roaming/Adobe/UXP"
WORKSPACE="/mnt/c/Users/$(powershell.exe -NoProfile -Command '$env:USERNAME' 2>/dev/null | tr -d '\r')/photoshop-ai-studio-workspace"
JSX_WIN='C:\Users\PLACEHOLDER\AppData\Local\Temp\studio-make-demo.jsx'
MARKER_WIN='/c/PLACEHOLDER/studio-fixture.txt'

USER_NAME="$(powershell.exe -NoProfile -Command '$env:USERNAME' 2>/dev/null | tr -d '\r')"
JSX_WIN="C:\\Users\\${USER_NAME}\\AppData\\Local\\Temp\\studio-make-demo.jsx"
MARKER_WSL="${WORKSPACE}/studio-fixture.txt"
MARKER_WIN="C:\\Users\\${USER_NAME}\\photoshop-ai-studio-workspace\\studio-fixture.txt"

rm -f "$MARKER_WSL"

# Inject the absolute output path the fixture must write its marker to.
STAGE_DIR="/mnt/c/Users/${USER_NAME}/AppData/Local/Temp"
mkdir -p "$STAGE_DIR"
FIXTURE_WSL="${WORKSPACE}/studio-fixture.txt"
{
  printf 'var FIXTURE_OUTPUT = "%s";\n' "$(printf '%s' "$MARKER_WIN" | sed 's/\\/\\\\/g')"
  cat scripts/make-demo-document.jsx
} > "$STAGE_DIR/studio-make-demo.jsx"

echo "running the fixture script through Photoshop COM…"
powershell.exe -NoProfile -Command "
\$ErrorActionPreference = 'Stop'
try {
  \$ps = New-Object -ComObject Photoshop.Application
  \$ps.BringToFront()
  \$ps.DoJavaScriptFile('${JSX_WIN}', @(), 1)
  Write-Output 'DoJavaScriptFile returned'
} catch {
  Write-Output ('FAILED: ' + \$_.Exception.Message)
  exit 1
}
" 2>&1 | tr -d '\r'

for _ in $(seq 1 20); do
  if [ -f "$MARKER_WSL" ]; then
    echo "fixture marker: $(cat "$MARKER_WSL")"
    exit 0
  fi
  sleep 1
done

echo "no marker at $MARKER_WSL — the script did not run to completion"
exit 1
