#requires -Version 5.1
<#
.SYNOPSIS
Build a Windows local installer from a reviewed commit.
.EXAMPLE
.\bin\build-local.ps1
Prompts for major, minor, or incremental using the current commit.
.EXAMPLE
.\bin\build-local.ps1 -Version 1.2.3 -Source <reviewed-commit>
.EXAMPLE
.\bin\build-local.ps1 -Version 1.2.3 -Source <reviewed-commit> -CheckOnly
.NOTES
Never publishes, installs, tags, pushes, or stops applications.
A completed installer consumes its version, even if later verification fails.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')]
    [string]$Version,
    [string]$Source = 'HEAD',
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    $stderrFile = [IO.Path]::GetTempFileName()
    try {
        & $Program @Arguments 2>&1>$stderrFile
        if ($LASTEXITCODE -ne 0) {
            $stderr = [IO.File]::ReadAllText($stderrFile).Trim()
            $detail = if ($stderr) { "`nstderr: $stderr" } else { '' }
            throw "$Program failed (exit $LASTEXITCODE).$detail Build stopped."
        }
    } finally {
        Remove-Item -LiteralPath $stderrFile -ErrorAction SilentlyContinue
    }
}

function Get-GitText {
    param([string[]]$Arguments)
    return ((Invoke-Checked git $Arguments) -join [Environment]::NewLine).Trim()
}

function Set-BuildVersion {
    param([string]$Root, [string]$Number)
    $patterns = [ordered]@{
        'package.json' = '(?m)^(\s{2}"version"\s*:\s*")[^"]+(")'
        'app/package.json' = '(?m)^(\s{2}"version"\s*:\s*")[^"]+(")'
        'sidecar/Cargo.toml' = '(?ms)(^\[package\]\r?\n(?:(?!^\[).)*?^version\s*=\s*")[^"]+(")'
        'sidecar/Cargo.lock' = '(?m)(^name = "hyperia-sidecar"\r?\nversion = ")[^"]+(")'
    }
    # Validate every replacement before writing any file.
    $updates = @{}
    foreach ($entry in $patterns.GetEnumerator()) {
        $path = Join-Path $Root $entry.Key
        $original = [IO.File]::ReadAllText($path)
        $regex = [regex]::new($entry.Value)
        if ($regex.Matches($original).Count -ne 1) { throw "Cannot locate exactly one version in $($entry.Key)" }
        $updates[$path] = $regex.Replace($original, { param($m) $m.Groups[1].Value + $Number + $m.Groups[2].Value })
    }
    foreach ($path in $updates.Keys) {
        [IO.File]::WriteAllText($path, $updates[$path], [Text.UTF8Encoding]::new($false))
    }
}

function Assert-VersionAvailable {
    param([string]$Root, [string]$Records, [string]$Number)
    $receipt = Join-Path $Records "$Number.json"
    if (Test-Path -LiteralPath $receipt) {
        $record = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
        if ($record.burned) { throw "Version $Number already produced an installer. Choose a new version." }
    }
    $existing = @(Get-ChildItem -LiteralPath (Join-Path $Root 'dist') -Filter "Hyperia-$Number-*.exe" -ErrorAction SilentlyContinue)
    if ($existing.Count) { throw "Installer already exists for $Number. It will not be overwritten." }
    if (Get-GitText @('tag', '--list', "v$Number")) { throw "Tag v$Number already exists. Choose a new version." }
}

function Get-VersionBaseline {
    param([string]$Root, [string]$Records, [string]$SourceVersion, [string[]]$Tags)
    $versions = @([version]$SourceVersion)
    foreach ($tag in $Tags) {
        if ($tag -match '^v(\d+\.\d+\.\d+)$') { $versions += [version]$Matches[1] }
    }
    foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $Root 'dist') -Filter 'Hyperia-*.exe' -ErrorAction SilentlyContinue)) {
        if ($file.Name -match '^Hyperia-(\d+\.\d+\.\d+)-') { $versions += [version]$Matches[1] }
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $Records -Filter '*.json' -ErrorAction SilentlyContinue)) {
        $record = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        if ($record.burned) { $versions += [version]$record.version }
    }
    return ($versions | Sort-Object -Descending | Select-Object -First 1)
}

function Select-BuildVersion {
    param([version]$BaseVersion)
    $major = '{0}.0.0' -f ($BaseVersion.Major + 1)
    $minor = '{0}.{1}.0' -f $BaseVersion.Major, ($BaseVersion.Minor + 1)
    $patch = '{0}.{1}.{2}' -f $BaseVersion.Major, $BaseVersion.Minor, ($BaseVersion.Build + 1)
    Write-Host "Version baseline (source, tags, completed local builds): $BaseVersion"
    Write-Host "  1. Major       -> $major"
    Write-Host "  2. Minor       -> $minor"
    Write-Host "  3. Incremental -> $patch"
    while ($true) {
        $choice = (Read-Host 'Choose major, minor, incremental (1/2/3), or q to cancel').Trim().ToLowerInvariant()
        switch ($choice) {
            { $_ -in @('1', 'major') } { return $major }
            { $_ -in @('2', 'minor') } { return $minor }
            { $_ -in @('3', 'incremental', 'patch') } { return $patch }
            'q' { throw 'Build cancelled before any changes.' }
            default { Write-Host 'Enter 1, 2, 3, major, minor, incremental, or q.' }
        }
    }
}

function Get-BlockingProcesses {
    param([string]$Root, [object[]]$Processes)
    $prefix = $Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    return @($Processes | Where-Object {
        $exe = [string]$_.ExecutablePath
        $cmd = [string]$_.CommandLine
        $fromRepo = $exe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
        ($fromRepo -and $_.Name -match '^(electron|Hyperia|hyperia-sidecar)\.exe$') -or
        ($_.Name -match '^(node|cmd)\.exe$' -and
            $cmd.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $cmd -match 'electronmon|electron[\\/]cli\.js|webpack.+(?:-w|--watch)|tsc.+--watch') -or
        ($_.Name -match '^(cargo|rustc)\.exe$' -and
            ($cmd -match 'hyperia.sidecar' -or $cmd.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0))
    })
}

function Assert-BuildSource {
    param([string]$Expected)
    if ((Get-GitText @('rev-parse', 'HEAD')) -ne $Expected -or
        (Get-GitText @('status', '--porcelain', '--untracked-files=normal'))) {
        throw 'Source or checkout changed during the build. Do not distribute this installer.'
    }
}

function Save-BuildRecord {
    param([string]$Path, [object]$Record)
    $temp = "$Path.tmp"
    [IO.File]::WriteAllText($temp, ($Record | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Build-LocalInstaller {
    param([string]$Root, [string]$Number, [string]$Revision, [switch]$InspectOnly)
    if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows.' }
    foreach ($command in @('git', 'node', 'yarn.cmd', 'cargo')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Missing tool: $command" }
    }
    $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
    if (-not (Get-ChildItem -Path "$sdk/*/x64/signtool.exe" -ErrorAction SilentlyContinue)) {
        throw 'Windows SDK signtool.exe is missing.'
    }
    $hasSigningSecret = -not [string]::IsNullOrWhiteSpace($env:AZURE_CLIENT_SECRET)
    $signingEnv = Join-Path $Root '.signing.env'
    if (-not $hasSigningSecret -and (Test-Path -LiteralPath $signingEnv)) {
        $hasSigningSecret = [IO.File]::ReadAllText($signingEnv) -match '(?m)^\s*AZURE_CLIENT_SECRET\s*=\s*["'']?[^"'']\S+'
    }
    if (-not $hasSigningSecret) { throw 'Signing requires AZURE_CLIENT_SECRET in the environment or .signing.env.' }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'build/win/trustedsigning/bin/x64/Azure.CodeSigning.Dlib.dll'))) {
        throw 'Azure Trusted Signing library is missing.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules/.bin/electron-builder.cmd'))) {
        throw 'Dependencies are missing. Run yarn install first.'
    }
    $sourceSha = Get-GitText @('rev-parse', '--verify', '--end-of-options', "$Revision^{commit}")
    $sourcePackage = (Get-GitText @('show', "${sourceSha}:package.json")) | ConvertFrom-Json
    $blockers = @(Get-BlockingProcesses $Root @(Get-CimInstance Win32_Process))
    if ($blockers.Count) {
        $blockers | Select-Object ProcessId, Name, ExecutablePath | Format-Table | Out-Host
        throw 'A repo dev app, watcher, or Rust build is running. Stop it yourself before building.'
    }
    $gitCommon = Get-GitText @('rev-parse', '--path-format=absolute', '--git-common-dir')
    $records = Join-Path $gitCommon 'local-builds'
    if (-not $Number) {
        $tags = @(Invoke-Checked git @('tag', '--list', 'v*'))
        $baseline = Get-VersionBaseline $Root $records $sourcePackage.version $tags
        $Number = Select-BuildVersion $baseline
    }
    if ([version]$Number -le [version]$sourcePackage.version) {
        throw "Version must be newer than reviewed source version $($sourcePackage.version)."
    }
    Assert-VersionAvailable $Root $records $Number
    $branch = "build/v$Number-local"
    $exists = Get-GitText @('branch', '--list', $branch)
    $versionFiles = @('package.json', 'app/package.json', 'sidecar/Cargo.toml', 'sidecar/Cargo.lock')
    # If a previous build at this version was killed hard (no finally block),
    # its record is stuck at 'building' and the build branch may still be
    # checked out with uncommitted version-file changes. Clean up BEFORE the
    # dirty-check so the retry doesn't trip on the killed build's leftovers.
    $staleReceipt = Join-Path $records "$Number.json"
    if (Test-Path -LiteralPath $staleReceipt) {
        $staleRecord = Get-Content -LiteralPath $staleReceipt -Raw | ConvertFrom-Json
        if ($staleRecord.status -eq 'building' -and -not $staleRecord.burned) {
            Write-Warning "Found stale 'building' record for $Number (killed build). Cleaning up."
            $staleRecord.status = 'incomplete'
            Save-BuildRecord $staleReceipt $staleRecord
            $currentBranch = Get-GitText @('branch', '--show-current')
            if ($currentBranch -eq $branch) {
                Invoke-Checked git @('switch', '-')
            }
            foreach ($vf in $versionFiles) {
                Invoke-Checked git @('checkout', '--', $vf)
            }
        }
    }
    $dirty = Get-GitText @('status', '--porcelain', '--untracked-files=normal')
    if ($dirty) { throw "Checkout must be clean before building. Commit or move these files first: $dirty" }
    if ($exists) {
        Invoke-Checked git @('merge-base', '--is-ancestor', $sourceSha, $branch)
        $changed = @(Invoke-Checked git @('diff', '--name-only', $sourceSha, $branch))
        if (@($changed | Where-Object { $_ -notin $versionFiles }).Count) {
            throw "$branch has changes beyond the version bump. It will not be reset."
        }
    }
    Write-Host "Source: $sourceSha | Local branch: $branch | Version: $Number"
    if ($InspectOnly) { Write-Host 'CHECK ONLY: no files, branches, or builds changed.'; return }

    New-Item -ItemType Directory -Path $records -Force | Out-Null
    $lock = [IO.File]::Open((Join-Path $records 'build.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $transcriptStarted = $false
    $record = $null
    $artifact = Join-Path $Root "dist/Hyperia-$Number-x64.exe"
    $receipt = Join-Path $records "$Number.json"
    $logDir = Join-Path $Root 'dist/local-builds'
    try {
        Assert-VersionAvailable $Root $records $Number
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        $log = Join-Path $logDir "$Number-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
        Start-Transcript -Path $log | Out-Null
        $transcriptStarted = $true
        if ($exists) { Invoke-Checked git @('switch', $branch) }
        else { Invoke-Checked git @('switch', '-c', $branch, $sourceSha) }
        Set-BuildVersion $Root $Number
        Invoke-Checked node @('bin/verify-version.js')
        Invoke-Checked git (@('add', '--') + $versionFiles)
        if (Get-GitText @('diff', '--cached', '--name-only')) {
            Invoke-Checked git @('commit', '-m', "chore(local-build): v$Number from $sourceSha")
        }
        $buildSha = Get-GitText @('rev-parse', 'HEAD')
        $record = [ordered]@{
            version = $Number; source = $sourceSha; build = $buildSha; branch = $branch
            started = [DateTime]::UtcNow.ToString('o'); burned = $false
            status = 'building'; artifact = $artifact; log = $log
        }
        Save-BuildRecord $receipt $record

        # Remove only the known, ignored agent link directory. Never follow its targets.
        $landmine = Join-Path $Root '.antigravitycli'
        if (Test-Path -LiteralPath $landmine) {
            if (Get-GitText @('ls-files', '--', '.antigravitycli')) {
                throw '.antigravitycli contains tracked files; refusing to remove it.'
            }
            Remove-Item -LiteralPath $landmine -Recurse -Force
        }

        Write-Host 'STEP 1/2: cargo build --release (sidecar)'
        Push-Location (Join-Path $Root 'sidecar')
        try { Invoke-Checked cargo @('build', '--release', '--locked') } finally { Pop-Location }
        Assert-BuildSource $buildSha
        Write-Host 'STEP 2/2: yarn run dist --publish never'
        Invoke-Checked yarn.cmd @('run', 'dist', '--publish', 'never')
        if (-not (Test-Path -LiteralPath $artifact)) { throw "Installer was not produced: $artifact" }

        # Burn immediately, before signature/package checks; their failure cannot free a version.
        $record.burned = $true
        $record.status = 'verifying'
        Save-BuildRecord $receipt $record
        $record['sha256'] = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
        $record['bytes'] = (Get-Item -LiteralPath $artifact).Length
        $signature = Get-AuthenticodeSignature -LiteralPath $artifact
        $record['signature'] = $signature.Status.ToString()
        $record['signer'] = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
        if ($signature.Status -ne 'Valid') { throw "Installer signature must be Valid; got $($signature.Status)." }
        foreach ($binary in @('dist/win-unpacked/Hyperia.exe', 'dist/win-unpacked/resources/sidecar/hyperia-sidecar.exe')) {
            $binarySignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $Root $binary)
            if ($binarySignature.Status -ne 'Valid') { throw "Invalid signature on $binary : $($binarySignature.Status)" }
        }
        $record['appSignature'] = 'Valid'
        $record['sidecarSignature'] = 'Valid'
        $verifyPackage = @'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');
const expected = process.argv[1];
const archive = path.resolve('dist/win-unpacked/resources/app.asar');
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
if (packaged.version !== expected) throw Error('Packaged app version mismatch');
const files = new Set(asar.listPackage(archive).map(p => p.replace(/\\/g, '/').replace(/^\//, '')));
let count = 0;
function checkAssets(dir = '') {
  for (const entry of fs.readdirSync(path.join('target', dir), {withFileTypes: true})) {
    if (entry.name === 'node_modules') continue;
    const name = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      // menus/menus/ holds platform-specific sub-menus (darwin.js, etc.) that
      // electron-builder may exclude from a cross-platform asar; skip them.
      if (name === 'menus/menus') continue;
      checkAssets(name); continue;
    }
    if (name === 'package.json' || !/\.(js|json|html|css)$/.test(name)) continue;
    if (!files.has(name)) throw Error('Packaged asset missing: ' + name);
    if (!fs.readFileSync(path.join('target', name)).equals(asar.extractFile(archive, name)))
      throw Error('Packaged asset differs: ' + name);
    count++;
  }
}
checkAssets();
if (!files.has('index.js')) throw Error('Packaged main entry missing');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
if (hash('sidecar/target/release/hyperia-sidecar.exe') !==
    hash('dist/win-unpacked/resources/sidecar/hyperia-sidecar.exe')) throw Error('Packaged sidecar mismatch');
console.log('PACKAGE VERIFIED: v' + expected + ', ' + count + ' app assets, matching sidecar.');
'@
        Invoke-Checked node @('-e', $verifyPackage, $Number)
        Assert-BuildSource $buildSha
        $record.status = 'verified'
        $record['completed'] = [DateTime]::UtcNow.ToString('o')
        Write-Host "LOCAL INSTALLER: $artifact"
        Write-Host "SHA256: $($record.sha256)"
        Write-Host "Signature: $($record.signature)"
        Write-Host "Source: $sourceSha | Build: $buildSha"
    } finally {
        try {
            if ($record) {
                if (Test-Path -LiteralPath $artifact) { $record.burned = $true }
                if ($record.status -ne 'verified') { $record.status = 'incomplete' }
                Save-BuildRecord $receipt $record
                Save-BuildRecord (Join-Path $logDir "$Number.json") $record
                if ($record.burned) { Write-Host "Version $Number is consumed. Use a new version for changed code." }
            }
        } finally {
            if ($transcriptStarted) { Stop-Transcript | Out-Null }
            $lock.Dispose()
        }
    }
}

# Dot sourcing exposes helpers to the regression tests without starting a build.
if ($MyInvocation.InvocationName -ne '.') {
    Push-Location (Split-Path -Parent $PSScriptRoot)
    try { Build-LocalInstaller (Get-Location).Path $Version $Source -InspectOnly:$CheckOnly }
    finally { Pop-Location }
}
