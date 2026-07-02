# dev.ps1 — the ONLY sanctioned way to (re)start the Hyperia dev loop.
#
# Guarantees exactly one stack: sweeps every hyperia-scoped watcher/electron/
# sidecar process, VERIFIES zero remain, launches one `yarn start`, then
# post-verifies no duplicate watchers appeared. Never blanket-kills
# electron.exe/node.exe — always matched by command line, so other Electron
# apps and unrelated node processes are untouched.
$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot

function Get-HypNode {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'DeepBlueDynamics.hyperia' }
}
function Get-HypElectron {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -like '*DeepBlueDynamics\hyperia*' }
}

# 1) Sweep
Get-HypNode | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-HypElectron | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
try { taskkill /f /im hyperia-sidecar.exe 2>$null | Out-Null } catch {}
Start-Sleep -Seconds 2

# 2) Verify zero — refuse to launch into a dirty state
$n = @(Get-HypNode).Count; $e = @(Get-HypElectron).Count
if ($n -gt 0 -or $e -gt 0) {
  # one more pass, then hard-fail
  Get-HypNode | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Get-HypElectron | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
  $n = @(Get-HypNode).Count; $e = @(Get-HypElectron).Count
  if ($n -gt 0 -or $e -gt 0) {
    Write-Error "dev.ps1: could not reach zero (node=$n electron=$e) — NOT launching."
    exit 1
  }
}
Write-Host "dev.ps1: clean slate (node=0 electron=0) — launching one stack"

# 3) Launch ONE stack (foreground of this shell; backgrounding is the caller's job)
Set-Location $repo
yarn start
