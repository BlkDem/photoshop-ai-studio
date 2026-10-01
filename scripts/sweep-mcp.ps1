<#
.SYNOPSIS
Runs every MCP operation against the live Photoshop plugin and reports pass/fail.

.DESCRIPTION
The primitive-level counterpart to `scripts/smoke.mjs`, which exercises the same
tools against the mock adapter. This one needs a real Photoshop with the plugin
connected, and is how a UXP change is verified before it is trusted.

Arguments are handed to the prober through a file rather than the command line.
A JSON argument passed to a native command is re-quoted by PowerShell 5.1 and
the prober dies with a syntax error inside an anonymous script, which looks
exactly like a broken tool.

.PARAMETER Probes
Path to a JSONL file of [tool, argsJson] pairs. Defaults to data/probes.jsonl.

.NOTES
These probe files are NOT self-contained. They expect an open document with layers
named Title, CTA, Logo and Background, which scripts/make-demo-document.jsx builds.
Against an accumulated document the failures look exactly like regressions —
"layer not found" for a layer that simply was never created this time — so build
the fixture first, or treat that message as a fixture question before a code one.

.EXAMPLE
powershell -File scripts/sweep-mcp.ps1
#>
[CmdletBinding()]
param([string] $Probes = 'data\probes.jsonl')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$NodeDir = Join-Path $env:USERPROFILE '.local\node\node-v22.23.3-win-x64'
if (Test-Path $NodeDir) { $env:Path = $NodeDir + ';' + $env:Path }
Set-Location $Root

if (-not (Test-Path $Probes)) { Write-Error "no probe list at $Probes"; exit 1 }

$argsFile = Join-Path $Root 'data\probe-args.json'
$pass = 0
$failures = @()
$index = 0

foreach ($line in Get-Content $Probes) {
  if (-not $line.Trim()) { continue }
  $index++
  $probe = $line | ConvertFrom-Json
  $tool = [string]$probe[0]

  # ASCII, no BOM: JSON.parse would choke on either.
  Set-Content -Path $argsFile -Value ([string]$probe[1]) -Encoding ascii -NoNewline

  $raw = & node @('scripts/probe-mcp.mjs', $tool, '--args-file', $argsFile) 2>&1 | Out-String
  $label = $tool.PadRight(22)

  try {
    $result = $raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json
    if ($result.success) {
      $pass++
      $json = $result.data | ConvertTo-Json -Compress -Depth 4
      Write-Host "$label ok   $($json.Substring(0, [Math]::Min(72, $json.Length)))"
    } else {
      $failures += "$tool -> $($result.error.code): $($result.error.message)"
      Write-Host "$label FAIL $($result.error.code): $($result.error.message)"
    }
  } catch {
    $failures += "$tool -> unparseable output"
    Write-Host "$label UNPARSEABLE: $($raw.Substring(0, [Math]::Min(120, $raw.Length)))"
  }
}

Write-Host ''
Write-Host "passed=$pass failed=$($failures.Count)"
if ($failures.Count) {
  Write-Host ''
  foreach ($failure in $failures) { Write-Host "  $failure" }
  exit 1
}