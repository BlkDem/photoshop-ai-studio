#!/usr/bin/env bash
# Installs (or uninstalls) the UXP plugin into Photoshop on a local Windows host.
#
# Why this exists: the UXP Developer Tool is the documented way to load an
# *unpackaged* plugin, but it is not distributable headlessly and needs sign-in.
# Photoshop loads *installed* plugins from the per-user UXP folder and registers
# them in a JSON database, which we can write directly:
#
#   %AppData%\Adobe\UXP\Plugins\External\<pluginId>_<version>\
#   %AppData%\Adobe\UXP\PluginsInfo\v1\PS.json
#
# Two requirements that are easy to get wrong and produce a silently-missing
# plugin:
#   1. `manifest.json` must declare `host` as an OBJECT. UDT's packaging step
#      rewrites the array form, so a dev manifest that worked under UDT will not
#      load here if it is left as an array.
#   2. `PS.json` must list the plugin with `"type": "uxp"` and a `path` relative
#      to the UXP plugins root, prefixed with the literal `$localPlugins\`.
#
#   scripts/install-plugin.sh            install
#   scripts/install-plugin.sh --status   report what Photoshop would load
#   scripts/install-plugin.sh --remove   uninstall
set -euo pipefail

PLUGIN_ID="com.blkdem.photoshop-ai-studio"
PLUGIN_VERSION="$(node -e "console.log(require('./photoshop-plugin/manifest.json').version)")"
SOURCE="$(cd "$(dirname "$0")/.." && pwd)/photoshop-plugin"

# Resolve the Windows user profile from the host rather than guessing: under WSL
# $USER is the Linux user, which is often not the Windows account name.
WIN_USER="${WIN_USER:-$(powershell.exe -NoProfile -Command '$env:USERNAME' 2>/dev/null | tr -d '\r')}"
WIN_USER="${WIN_USER:-$USER}"
APPDATA_UXP="${APPDATA_UXP:-/mnt/c/Users/${WIN_USER}/AppData/Roaming/Adobe/UXP}"
TARGET="$APPDATA_UXP/Plugins/External/${PLUGIN_ID}_${PLUGIN_VERSION}"
DB="$APPDATA_UXP/PluginsInfo/v1/PS.json"

log() { printf '%s\n' "$*"; }

status() {
  log "windows user  : $WIN_USER"
log "source        : $SOURCE"
  log "target        : $TARGET"
  log "registry      : $DB"
  if [ -f "$TARGET/manifest.json" ]; then
    log "installed     : yes ($(find "$TARGET" -type f | wc -l) files)"
  else
    log "installed     : no"
  fi
  if [ -f "$DB" ]; then
    log "registry entry:"
    python3 -c "
import json, sys
db = json.load(open(sys.argv[1]))
hit = next((p for p in db.get('plugins', []) if p.get('pluginId') == sys.argv[2]), None)
print(json.dumps(hit, indent=2) if hit else '  (none)')
" "$DB" "$PLUGIN_ID" 2>/dev/null || log "  (could not parse $DB)"
  else
    log "registry      : no $DB"
  fi
  log "runtime data  : $APPDATA_UXP/PluginsStorage/PHSP/26/External/${PLUGIN_ID}"
  if [ -d "$APPDATA_UXP/PluginsStorage/PHSP/26/External/${PLUGIN_ID}" ]; then
    log "  -> present: Photoshop has loaded this plugin at least once."
  else
    log "  -> absent: Photoshop has NOT loaded this plugin yet."
  fi
}

remove() {
  rm -rf "$TARGET"
  if [ -f "$DB" ]; then
    python3 -c "
import json, sys
db = json.load(open(sys.argv[1]))
db['plugins'] = [p for p in db.get('plugins', []) if p.get('pluginId') != sys.argv[2]]
open(sys.argv[1], 'w').write(json.dumps(db, indent=2))
" "$DB" "$PLUGIN_ID"
  fi
  log "removed $TARGET and its registry entry"
}

case "${1:-install}" in
  --status)
    status
    exit 0
    ;;
  --remove)
    remove
    exit 0
    ;;
esac

# --- sanity check the manifest before installing ----------------------------
node -e "
  const fs = require('fs');
  const manifest = JSON.parse(fs.readFileSync('$SOURCE/manifest.json', 'utf8'));
  const problems = [];
  if (Array.isArray(manifest.host)) {
    problems.push('\`host\` is an array; it must be an object for a hand-installed plugin');
  }
  if (manifest.host?.minVersion !== '25.0.0') {
    problems.push('unexpected host.minVersion: ' + manifest.host?.minVersion);
  }
  if (!manifest.main) problems.push('no \`main\` entry');
  if (problems.length) { console.error('manifest problems:\n  - ' + problems.join('\n  - ')); process.exit(1); }
  console.log('manifest ok:', manifest.id, manifest.version, '-> host', manifest.host.app, manifest.host.minVersion);
"

# --- copy ------------------------------------------------------------------
mkdir -p "$TARGET"
# `test/` holds TypeScript contract tests that only run under vitest; shipping it
# would be dead weight inside Photoshop.
rm -rf "$TARGET/test"
for item in manifest.json config.json index.html index.js styles.css lib icons; do
  cp -r "$SOURCE/$item" "$TARGET/"
done
log "copied $(find "$TARGET" -type f | wc -l) files to $TARGET"

# --- register --------------------------------------------------------------
# Written with python rather than inline node: `$localPlugins\External\...`
# contains backslashes, and every layer of shell -> JS -> JSON escaping mangles
# them. A doubled backslash here is a silent "plugin does not appear" bug.
mkdir -p "$(dirname "$DB")"
python3 - "$DB" "$PLUGIN_ID" "$PLUGIN_VERSION" <<'PY'
import json, os, sys
db_path, plugin_id, version = sys.argv[1], sys.argv[2], sys.argv[3]
db = {"plugins": []}
if os.path.exists(db_path):
    try:
        db = json.load(open(db_path))
    except Exception:
        db = {"plugins": []}
entry = {
    "hostMinVersion": "25.0.0",
    "name": plugin_id,
    "path": "$localPlugins\\External\\%s_%s" % (plugin_id, version),
    "pluginId": plugin_id,
    "status": "enabled",
    "type": "uxp",
    "versionString": version,
}
db["plugins"] = [p for p in db.get("plugins", []) if p.get("pluginId") != plugin_id]
db["plugins"].append(entry)
open(db_path, "w").write(json.dumps(db, indent=2))
print("registered:", json.dumps(entry, indent=2))
PY

log ""
status
log ""
log "Next: start Photoshop. The plugin connects on load (loadEvent: startup) and"
log "should log \`hello\` in the MCP server's bridge log:"
log "  tail -f logs/mcp.log"
