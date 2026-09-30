<#
.SYNOPSIS
Starts (or stops) the Photoshop AI Studio stack on this Windows host.

.DESCRIPTION
Photoshop only runs on Windows, and a UXP plugin cannot leave the machine it is
loaded into. Running the server under WSL therefore meant every path crossed an
OS boundary — the plugin wanted `C:\...`, the server wanted `/mnt/c/...`, and
publishing an export meant translating one into the other on every call. With
the stack here there is one filesystem, one set of paths, and no translation.

Starts three processes in the background, each logging to logs\<name>.log:
  mcp           the MCP server and the UXP bridge (ws://localhost:3002/bridge)
  orchestrator  plan -> approval -> execute -> diff -> verify
  studio        the web UI

.PARAMETER Stop
Stop everything this script started.

.EXAMPLE
powershell -File scripts/dev-up.ps1
powershell -File scripts/dev-up.ps1 -Stop
#>
[CmdletBinding()]
param([switch] $Stop)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

function Write-Step($message) { Write-Host $message }

# The machine-wide Node predates the toolchain (vitest imports `node:util`'s
# `styleText`, Node 22+), so the local build is pinned explicitly rather than
# trusting whatever PATH this shell inherited.
$NodeDir = Join-Path $env:USERPROFILE '.local\node\node-v22.23.3-win-x64'
if (Test-Path $NodeDir) { $env:Path = $NodeDir + ';' + $env:Path }

function Stop-Stack {
  foreach ($pattern in @('mcp-server\dist\index.js', 'orchestrator\dist\index.js', 'vite')) {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like "*$pattern*" } |
      ForEach-Object {
        Write-Step "stopping pid $($_.ProcessId) ($pattern)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
  }
  Write-Step 'stopped'
}

if ($Stop) { Stop-Stack; exit 0 }

Set-Location $Root
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data'), (Join-Path $Root 'logs') | Out-Null

function Start-ProcessLogged($name, $arguments) {
  $log = Join-Path $Root "logs\$name.log"
  $process = Start-Process -FilePath 'node' -ArgumentList $arguments -WorkingDirectory $Root `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
  $process.Id | Set-Content (Join-Path $Root "data\$name.pid")
  Write-Step "  $name pid $($process.Id)  -> logs\$name.log"
}

Write-Step 'building…'
& npm run build *> $null
if ($LASTEXITCODE -ne 0) { Write-Error 'build failed'; exit 1 }

Start-ProcessLogged 'mcp' @('mcp-server/dist/index.js')
Start-ProcessLogged 'orchestrator' @('orchestrator/dist/index.js')

Start-Process -FilePath 'npm.cmd' -ArgumentList @('--workspace', 'studio', 'run', 'dev') -WorkingDirectory $Root `
  -RedirectStandardOutput (Join-Path $Root 'logs\studio.log') `
  -RedirectStandardError (Join-Path $Root 'logs\studio.log.err') -WindowStyle Hidden | Out-Null
Write-Step '  studio          -> logs\studio.log'

Start-Sleep -Seconds 5
Write-Host ''
Write-Step 'health:'
foreach ($probe in @('http://127.0.0.1:3001/health', 'http://127.0.0.1:3003/api/health')) {
  try {
    $body = (Invoke-WebRequest -Uri $probe -UseBasicParsing -TimeoutSec 5).Content
    Write-Host "  $probe -> $($body.Substring(0, [Math]::Min(160, $body.Length)))"
  } catch {
    Write-Host "  $probe -> unreachable"
  }
}

Write-Host ''
Write-Step 'bridge log tail (watch Photoshop connect):'
Get-Content (Join-Path $Root 'logs\mcp.log') -Tail 5 -ErrorAction SilentlyContinue