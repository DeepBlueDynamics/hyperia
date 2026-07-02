# hyperia-local.ps1 - map hyperia.local to 127.0.0.1 in the Windows hosts file
# so http://hyperia.local:9800/shell works in ANY browser on this machine
# (Chrome, Edge, and inside Hyperia web panes). Idempotent; self-elevates.
# ASCII ONLY in this file: Windows PowerShell 5.1 misparses UTF-8 without BOM.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\hyperia-local.ps1          # install
#   powershell -ExecutionPolicy Bypass -File scripts\hyperia-local.ps1 -Remove  # uninstall
param([switch]$Remove)

$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$entry = "127.0.0.1`thyperia.local"
$marker = 'hyperia.local'

# Self-elevate: hosts edits need admin.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($Remove) { $args += '-Remove' }
  Start-Process powershell -Verb RunAs -ArgumentList $args -Wait
  exit $LASTEXITCODE
}

$lines = Get-Content $hostsPath -ErrorAction Stop
$has = $lines | Where-Object { $_ -match $marker -and $_ -notmatch '^\s*#' }

if ($Remove) {
  if ($has) {
    $lines | Where-Object { $_ -notmatch $marker } | Set-Content $hostsPath -Encoding ASCII
    Write-Host "removed hyperia.local from hosts"
  } else {
    Write-Host "hyperia.local not present - nothing to do"
  }
} else {
  if ($has) {
    Write-Host "hyperia.local already mapped - nothing to do"
  } else {
    Add-Content $hostsPath -Value $entry -Encoding ASCII
    Write-Host "mapped hyperia.local -> 127.0.0.1"
  }
  Write-Host "try it: http://hyperia.local:9800/shell"
}
