<#
.SYNOPSIS
Installs (or uninstalls) the UXP plugin into Photoshop on this Windows host.

.DESCRIPTION
Photoshop runs on Windows, so the whole stack does too, and this is the native
way to get the plugin in. The UXP Developer Tool is the documented way to load an
*unpackaged* plugin, but it is not distributable headlessly and needs sign-in.
Photoshop loads *installed* plugins from the per-user UXP folder and registers
them in a JSON database, which this script writes directly:

  %AppData%\Adobe\UXP\Plugins\External\<pluginId>_<version>\
  %AppData%\Adobe\UXP\PluginsInfo\v1\PS.json

Two requirements that are easy to get wrong and produce a silently-missing
plugin:
  1. `manifest.json` must declare `host` as an OBJECT. UDT's packaging step
     rewrites the array form, so a dev manifest that worked under UDT will not
     load here if it is left as an array.
  2. `PS.json` must list the plugin with `"type": "uxp"` and a `path` relative
     to the UXP plugins root, prefixed with the literal `$localPlugins\`.

.PARAMETER Status
Report what Photoshop would load, without changing anything.

.PARAMETER Remove
Uninstall the plugin and drop its registry entry.

.EXAMPLE
powershell -File scripts/install-plugin.ps1
powershell -File scripts/install-plugin.ps1 -Status
#>
[CmdletBinding()]
param(
  [switch] $Status,
  [switch] $Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PluginId = 'com.blkdem.photoshop-ai-studio'
$Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$Source = Join-Path $Root 'photoshop-plugin'

$manifest = Get-Content (Join-Path $Source 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version

$UxpRoot = Join-Path $env:APPDATA 'Adobe\UXP'
$target = Join-Path $UxpRoot "Plugins\External\${PluginId}_${version}"
$database = Join-Path $UxpRoot 'PluginsInfo\v1\PS.json'
$storage = Join-Path $UxpRoot "PluginsStorage\PHSP\26\External\$PluginId"

function Write-Step($message) { Write-Host $message }

function Show-Status {
  Write-Step "windows user  : $env:USERNAME"
  Write-Step "source        : $Source"
  Write-Step "target        : $target"
  Write-Step "registry      : $database"

  if (Test-Path (Join-Path $target 'manifest.json')) {
    $count = (Get-ChildItem $target -Recurse -File | Measure-Object).Count
    Write-Step "installed     : yes ($count files)"
  } else {
    Write-Step "installed     : no"
  }

  if (Test-Path $database) {
    $db = Get-Content $database -Raw | ConvertFrom-Json
    $hit = $db.plugins | Where-Object { $_.pluginId -eq $PluginId }
    Write-Step "registry entry:"
    if ($hit) { Write-Step ($hit | ConvertTo-Json -Depth 4) } else { Write-Step '  (none)' }
  } else {
    Write-Step "registry      : no $database"
  }

  if (Test-Path $storage) {
    Write-Step "runtime data  : present — Photoshop has loaded this plugin at least once."
  } else {
    Write-Step "runtime data  : absent — Photoshop has NOT loaded this plugin yet."
  }
}

if ($Status) { Show-Status; exit 0 }

if ($Remove) {
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  if (Test-Path $database) {
    $db = Get-Content $database -Raw | ConvertFrom-Json
    $db.plugins = @($db.plugins | Where-Object { $_.pluginId -ne $PluginId })
    $db | ConvertTo-Json -Depth 6 | Set-Content $database -Encoding utf8
  }
  Write-Step "removed $target and its registry entry"
  exit 0
}

# --- sanity check the manifest before installing ----------------------------
$problems = @()
if ($manifest.host -is [System.Array]) {
  $problems += '`host` is an array; it must be an object for a hand-installed plugin'
}
if ($manifest.host.minVersion -ne '25.0.0') {
  $problems += "unexpected host.minVersion: $($manifest.host.minVersion)"
}
if (-not $manifest.main) { $problems += 'no `main` entry' }
if ($problems.Count) {
  Write-Error ("manifest problems:`n  - " + ($problems -join "`n  - "))
  exit 1
}
Write-Step "manifest ok: $($manifest.id) $($manifest.version) -> host $($manifest.host.app) $($manifest.host.minVersion)"

# --- copy ------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($item in @('manifest.json', 'config.json', 'index.html', 'index.js', 'styles.css', 'lib', 'icons', 'test')) {
  # Remove before copying, always.
  #
  # `Copy-Item <dir> <existing-dir> -Recurse` copies the directory *into* the
  # destination rather than merging into it, so an update run leaves the real
  # files untouched and creates `lib\lib` instead. Photoshop then loads the first
  # build ever installed while the installer cheerfully reports success — the
  # kind of failure that makes a plugin edit look like it did nothing.
  $stale = Join-Path $target $item
  if (Test-Path $stale) { Remove-Item $stale -Recurse -Force }
}
foreach ($item in @('manifest.json', 'config.json', 'index.html', 'index.js', 'styles.css', 'lib', 'icons')) {
  $from = Join-Path $Source $item
  $to = Join-Path $target $item
  if (Test-Path $from -PathType Container) {
    Copy-Item $from $to -Recurse -Force
  } else {
    Copy-Item $from $to -Force
  }
}
# `test/` holds TypeScript contract tests that only run under vitest; shipping it
# would be dead weight inside Photoshop.
if (Test-Path (Join-Path $target 'test')) { Remove-Item (Join-Path $target 'test') -Recurse -Force }
# Verify rather than trust.
#
# A silent copy failure here is invisible for hours: the plugin keeps running the
# build it was installed with, every new fix appears to do nothing, and the only
# clue is an old line number in a log. Comparing the file *contents* by name and
# length catches the case that "copied N files" does not.
$sourceFiles = Get-ChildItem $Source -Recurse -File | Where-Object { $_.FullName -notmatch '\\test\\' }
$targetFiles = Get-ChildItem $target -Recurse -File
Write-Step "copied $($targetFiles.Count) files to $target"

$mismatched = @()
foreach ($file in $sourceFiles) {
  if ($file.FullName -match '\\test\\') { continue }
  $relative = $file.FullName.Substring($Source.Length).TrimStart('\')
  $installed = Join-Path $target $relative
  if (-not (Test-Path $installed)) { $mismatched += "$relative (missing)"; continue }
  if ((Get-FileHash $file.FullName).Hash -ne (Get-FileHash $installed).Hash) { $mismatched += "$relative (differs)" }
}
if ($mismatched.Count) {
  Write-Error ("the installed plugin does not match the source:`n  - " + ($mismatched -join "`n  - "))
  exit 1
}
Write-Step 'verified: every installed file matches the source' 

# --- register --------------------------------------------------------------
# A doubled backslash in the path below is a silent "plugin does not appear"
# bug, so the entry is built with the `\\` separators PS.json expects and written
# through ConvertTo-Json rather than assembled by hand.
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $database) | Out-Null
$db = @{ plugins = @() }
if (Test-Path $database) {
  try { $db = Get-Content $database -Raw | ConvertFrom-Json } catch { $db = @{ plugins = @() } }
}

$entry = [ordered]@{
  hostMinVersion = '25.0.0'
  name           = $PluginId
  path           = "`$localPlugins\External\${PluginId}_${version}"
  pluginId       = $PluginId
  status         = 'enabled'
  type           = 'uxp'
  versionString  = $version
}

$db.plugins = @($db.plugins | Where-Object { $_.pluginId -ne $PluginId }) + @([pscustomobject]$entry)
$db | ConvertTo-Json -Depth 6 | Set-Content $database -Encoding utf8
Write-Step "registered $($PluginId) $version"

Write-Host ''
Show-Status
Write-Host ''
Write-Host 'Next: start Photoshop. The plugin connects on load (loadEvent: startup) and'
Write-Host 'should log `hello` in the MCP server bridge log.'