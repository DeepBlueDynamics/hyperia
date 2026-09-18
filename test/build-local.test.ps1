#requires -Version 5.1
# Bounded checks for version changes, version reuse, and installed/dev process separation.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../bin/build-local.ps1"
$root = Join-Path (Split-Path -Parent $PSScriptRoot) ('dist/local-build-check-' + [guid]::NewGuid().ToString('N'))
$checks = 0
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Assert-Rejected([scriptblock]$Action, [string]$Expected) {
    try { & $Action } catch {
        Assert-True ($_.Exception.Message -like "*$Expected*") "Wrong rejection: $_"
        return
    }
    throw "Expected rejection containing: $Expected"
}
# This fixture has no Git metadata. Only the tag query is replaced.
function Get-GitText([string[]]$Arguments) {
    if ($Arguments[0] -ne 'tag') { throw 'Unexpected Git command in fixture' }
    if ($Arguments[-1] -eq 'v9.9.7') { return 'v9.9.7' }
    return ''
}
try {
    New-Item -ItemType Directory -Path "$root/app", "$root/sidecar", "$root/dist", "$root/records" -Force | Out-Null
    foreach ($file in @('package.json', 'app/package.json', 'sidecar/Cargo.toml', 'sidecar/Cargo.lock')) {
        Copy-Item -LiteralPath "$PSScriptRoot/../$file" -Destination "$root/$file"
    }
    $originalLock = [IO.File]::ReadAllText("$root/sidecar/Cargo.lock")
    Set-BuildVersion $root '9.9.8'
    Assert-True ((Get-Content "$root/package.json" -Raw | ConvertFrom-Json).version -eq '9.9.8') 'Root version'
    Assert-True ((Get-Content "$root/app/package.json" -Raw | ConvertFrom-Json).version -eq '9.9.8') 'App version'
    Assert-True ((Get-Content "$root/sidecar/Cargo.toml" -Raw) -match '(?m)^version = "9.9.8"') 'Crate version'
    $updatedLock = [IO.File]::ReadAllText("$root/sidecar/Cargo.lock")
    Assert-True ($updatedLock -match 'name = "hyperia-sidecar"\r?\nversion = "9.9.8"') 'Lock version'
    $pattern = '(?m)(^name = "hyperia-sidecar"\r?\nversion = ")[^"]+(")'
    Assert-True (([regex]::Replace($originalLock, $pattern, 'VERSION')) -ceq
        ([regex]::Replace($updatedLock, $pattern, 'VERSION'))) 'Unrelated lock dependencies changed'
    $before = [IO.File]::ReadAllText("$root/package.json")
    [IO.File]::WriteAllText("$root/sidecar/Cargo.lock", 'malformed')
    Assert-Rejected { Set-BuildVersion $root '9.9.9' } 'exactly one version'
    Assert-True ([IO.File]::ReadAllText("$root/package.json") -ceq $before) 'Partial bump on malformed lock'

    Assert-VersionAvailable $root "$root/records" '9.9.8'
    $checks++
    Assert-Rejected { Assert-VersionAvailable $root "$root/records" '9.9.7' } 'Tag'
    Save-BuildRecord "$root/records/9.9.8.json" @{burned = $false; status = 'incomplete'}
    Assert-VersionAvailable $root "$root/records" '9.9.8'
    $checks++
    [IO.File]::WriteAllText("$root/dist/Hyperia-9.9.8-x64.exe", 'fixture')
    Assert-Rejected { Assert-VersionAvailable $root "$root/records" '9.9.8' } 'already exists'
    Remove-Item -LiteralPath "$root/dist/Hyperia-9.9.8-x64.exe"
    Save-BuildRecord "$root/records/9.9.8.json" @{burned = $true; status = 'incomplete'; version = '9.9.8'}
    Assert-Rejected { Assert-VersionAvailable $root "$root/records" '9.9.8' } 'already produced'
    $baseline = Get-VersionBaseline $root "$root/records" '9.9.1' @('v9.9.3')
    Assert-True ($baseline -eq [version]'9.9.8') 'Completed local version omitted from prompt baseline'
    function Read-Host { return $script:answer }
    $script:answer = 'major'
    Assert-True ((Select-BuildVersion $baseline) -eq '10.0.0') 'Major choice'
    $script:answer = 'minor'
    Assert-True ((Select-BuildVersion $baseline) -eq '9.10.0') 'Minor choice'
    $script:answer = 'incremental'
    Assert-True ((Select-BuildVersion $baseline) -eq '9.9.9') 'Incremental choice'
    $script:answer = 'q'
    Assert-Rejected { Select-BuildVersion $baseline } 'cancelled'

    $processes = @(
        [pscustomobject]@{Name='Hyperia.exe'; ExecutablePath='C:\Users\test\AppData\Local\Programs\Hyperia\Hyperia.exe'; CommandLine='installed'},
        [pscustomobject]@{Name='hyperia-sidecar.exe'; ExecutablePath='C:\Users\test\AppData\Local\Programs\Hyperia\resources\sidecar\hyperia-sidecar.exe'; CommandLine='installed'},
        [pscustomobject]@{Name='electron.exe'; ExecutablePath="$root\node_modules\electron\dist\electron.exe"; CommandLine='dev'},
        [pscustomobject]@{Name='node.exe'; ExecutablePath='C:\node\node.exe'; CommandLine="node $root\node_modules\electronmon\bin\electronmon.js target"}
    )
    $blocked = @(Get-BlockingProcesses $root $processes)
    Assert-True ($blocked.Count -eq 2) 'Installed app blocked or repo dev process missed'
    Assert-True ($blocked[0].Name -eq 'electron.exe' -and $blocked[1].Name -eq 'node.exe') 'Wrong processes blocked'
    Assert-Rejected { Invoke-Checked node @('-e', 'process.exit(17)') } 'exit 17'
    Write-Host "PASS local build safeguards: $checks checks"
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
