#requires -Version 5.1
<#
  find-hyperia.ps1  (read-only forensic hunter)

  Finds every place the Windows shell could still be caching a stale
  "hyperia" -> Electron-icon mapping. Searches the byte content of:
    - IconCache.db + Explorer iconcache_*.db / thumbcache_*.db  (taskbar icon caches)
    - Jump lists (AutomaticDestinations / CustomDestinations)   (AUMID-keyed)
    - .lnk shortcuts: pinned taskbar, Start menu, Recent, Desktop (bytes + resolved target)
    - Start/tile caches
    - Scoped registry: AppUserModelId, Applications, Taskband, JumpLists, BagMRU

  Two encodings are scanned because AUMIDs live in .lnk PropertyStores as
  UTF-16LE while icon caches store ANSI paths:
    ANSI     -> "hyperia"
    UTF16LE  -> "h\0y\0p\0e\0r\0i\0a\0"

  Files locked by explorer are read with FileShare.ReadWrite so we can still
  inspect them; anything still unreadable is reported as LOCKED.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\find-hyperia.ps1
    powershell -ExecutionPolicy Bypass -File .\find-hyperia.ps1 -Needle "deepbluedynamics"
#>
[CmdletBinding()]
param(
    [string]$Needle = 'hyperia',
    [int]   $Context = 28
)

$ErrorActionPreference = 'SilentlyContinue'
$hitCount  = 0
$lockCount = 0
$prioritized = New-Object System.Collections.Generic.List[object]

function Write-Section($t) { Write-Host "`n==== $t ====" -ForegroundColor Cyan }

function Get-FileBytes {
    param([string]$Path)
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
              [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $ms = New-Object System.IO.MemoryStream
            $fs.CopyTo($ms)
            return ,[byte[]]$ms.ToArray()
        } finally { $fs.Dispose() }
    } catch { return $null }
}

function Search-Bytes {
    param([byte[]]$Bytes, [string]$Pat)
    $text = [System.Text.Encoding]::GetEncoding(28591).GetString($Bytes)
    $out  = New-Object System.Collections.Generic.List[object]

    foreach ($m in [regex]::Matches($text, [regex]::Escape($Pat), 'IgnoreCase')) {
        $out.Add([pscustomobject]@{ Encoding = 'ANSI'; Index = $m.Index })
    }
    $u16 = ($Pat.ToCharArray() | ForEach-Object { "$_`0" }) -join ''
    foreach ($m in [regex]::Matches($text, [regex]::Escape($u16), 'IgnoreCase')) {
        $out.Add([pscustomobject]@{ Encoding = 'UTF16LE'; Index = $m.Index })
    }
    return ,$out
}

function Clean-Context {
    param([byte[]]$Bytes, [int]$Index, [int]$Span)
    $start = [Math]::Max(0, $Index - $Span)
    $end   = [Math]::Min($Bytes.Length - 1, $Index + $Span)
    $sb = New-Object System.Text.StringBuilder
    for ($i = $start; $i -le $end; $i++) {
        $b = $Bytes[$i]
        if     ($b -ge 32 -and $b -lt 127) { [void]$sb.Append([char]$b) }
        elseif ($b -eq 0)                  { }
        else                               { [void]$sb.Append('.') }
    }
    return $sb.ToString()
}

function Search-File {
    param([string]$Path)
    $r = [pscustomobject]@{ Path = $Path; Status = 'unknown'; Size = 0; Hits = @() }
    $item = Get-Item -LiteralPath $Path -Force
    if ($null -eq $item)            { $r.Status = 'missing'; return $r }
    if ($item -is [System.IO.DirectoryInfo]) { $r.Status = 'dir'; return $r }
    $r.Size = $item.Length
    $bytes  = Get-FileBytes $Path
    if ($null -eq $bytes)        { $r.Status = 'LOCKED'; return $r }
    if ($bytes.Length -eq 0)     { $r.Status = 'empty';  return $r }
    $hits = Search-Bytes -Bytes $bytes -Pat $Needle
    if ($hits.Count -eq 0)       { $r.Status = 'clean';  return $r }
    $ctx = foreach ($h in $hits) {
        [pscustomobject]@{ Encoding = $h.Encoding; Offset = $h.Index;
                           Context  = (Clean-Context -Bytes $bytes -Index $h.Index -Span $Context) }
    }
    $r.Status = 'HIT'
    $r.Hits   = @($ctx)
    return $r
}

function Search-Target {
    param([string]$Label, [string]$Dir, [string[]]$Include, [switch]$Recurse)
    Write-Section $Label
    if (-not (Test-Path -LiteralPath $Dir)) {
        Write-Host "  (missing) $Dir" -ForegroundColor DarkGray
        return
    }
    $files = if ($Recurse) {
        Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -Include $Include
    } else {
        foreach ($inc in $Include) { Get-ChildItem -LiteralPath $Dir -Filter $inc -File -Force }
    }
    $scanned = 0
    foreach ($f in $files) {
        $scanned++
        $r = Search-File -Path $f.FullName
        switch ($r.Status) {
            'LOCKED' {
                $script:lockCount++
                Write-Host ("  [LOCKED] {0}  ({1:N0} bytes) — open by explorer; clear after kill" -f $r.Path, $r.Size) -ForegroundColor Yellow
                $script:prioritized.Add([pscustomobject]@{ Kind='LOCKED cache'; Path=$r.Path; Why='Held open by explorer — must delete then restart explorer' })
            }
            'HIT' {
                $script:hitCount++
                Write-Host ("  [HIT]    {0}  ({1:N0} bytes)" -f $r.Path, $r.Size) -ForegroundColor Green
                foreach ($h in $r.Hits) {
                    Write-Host ("           {0,-8} @0x{1:X}  …{2}…" -f $h.Encoding, $h.Offset, $h.Context) -ForegroundColor Gray
                }
                if ($f.Extension -eq '.lnk') {
                    $tg = Resolve-LnkTarget -Path $r.Path
                    Write-Host ("           target: {0}  exists={1} {2}" -f $tg.Target, $tg.Exists, $tg.Note) -ForegroundColor Magenta
                    if ($tg.Note -or $tg.Exists -eq 'NO') {
                        $script:prioritized.Add([pscustomobject]@{ Kind='Stale/electron .lnk'; Path=$r.Path; Why=("target={0} exists={1} {2}" -f $tg.Target,$tg.Exists,$tg.Note) })
                    } else {
                        $script:prioritized.Add([pscustomobject]@{ Kind='.lnk carrying AUMID'; Path=$r.Path; Why='PropertyStore contains the AUMID — check its icon reference' })
                    }
                } else {
                    $script:prioritized.Add([pscustomobject]@{ Kind='Cache hit'; Path=$r.Path; Why='Contains the needle — likely holding the stale icon mapping' })
                }
            }
            'clean'  { }
            default  { }
        }
    }
    Write-Host ("  scanned {0} file(s)" -f $scanned) -ForegroundColor DarkGray
}

$wsh = New-Object -ComObject WScript.Shell
function Resolve-LnkTarget {
    param([string]$Path)
    try {
        $sc = $wsh.CreateShortcut($Path)
        $tp = $sc.TargetPath
        $exists   = if ($tp -and (Test-Path -LiteralPath $tp)) { 'yes' } else { 'NO' }
        $electron = if ($tp -match 'electron') { '<-- ELECTRON.exe' } else { '' }
        return [pscustomobject]@{ Target = $tp; Exists = $exists; Note = $electron }
    } catch {
        return [pscustomobject]@{ Target = '(unreadable)'; Exists = '-'; Note = '' }
    }
}

function Search-Registry {
    param([string]$Root, [int]$MaxDepth = 3, [int]$Depth = 0)
    $key = Get-Item -LiteralPath $Root
    if ($null -eq $key) { return }
    $leaf = $key.PSChildName
    $keyHit = $false
    if ($leaf -and $leaf -match [regex]::Escape($Needle)) {
        $script:hitCount++
        Write-Host ("  [KEY]    {0}" -f $key.PSPath) -ForegroundColor Green
        $script:prioritized.Add([pscustomobject]@{ Kind='Registry key'; Path=$key.PSPath; Why='Key name matches — registered AppUserModelId / association' })
        $keyHit = $true
    }
    foreach ($vn in $key.GetValueNames()) {
        $vname = if ([string]::IsNullOrEmpty($vn)) { '(Default)' } else { $vn }
        $val   = $key.GetValue($vn)
        $vs    = if ($null -eq $val) { '' } else { ($val -join ' ') }
        $matchedData = ($vs -and $vs -match [regex]::Escape($Needle))
        $matchedName = ($vname -match [regex]::Escape($Needle))
        if ($keyHit) {
            Write-Host ("           {0} = {1}" -f $vname, $vs) -ForegroundColor Gray
        } elseif ($matchedData -or $matchedName) {
            $script:hitCount++
            Write-Host ("  [VAL]    {0}  ! {1}" -f $key.PSPath, '') -ForegroundColor Green
            Write-Host ("           {0} = {1}" -f $vname, $vs) -ForegroundColor Gray
            $script:prioritized.Add([pscustomobject]@{ Kind='Registry value'; Path=$key.PSPath; Why=("$vname = $vs") })
        }
    }
    if ($Depth -lt $MaxDepth) {
        foreach ($sub in (Get-ChildItem -LiteralPath $Root)) {
            Search-Registry -Root $sub.PSPath -MaxDepth $MaxDepth -Depth ($Depth + 1)
        }
    }
}

Write-Host "Searching for: '$Needle'  (ANSI + UTF-16LE)" -ForegroundColor White

$L = ${env:LOCALAPPDATA}; $A = ${env:APPDATA}; $U = ${env:USERPROFILE}

Search-Target 'A. Shell icon caches (taskbar/Start icon)' `
    "$L\Microsoft\Windows\Explorer" @('iconcache_*.db','thumbcache_*.db','*.idx') 
Search-Target 'A2. Legacy IconCache.db' `
    "$L" @('IconCache.db')
Search-Target 'B. Jump lists (AUMID-keyed)' `
    "$A\Microsoft\Windows\Recent\AutomaticDestinations" @('*')
Search-Target 'B2. Custom jump lists' `
    "$A\Microsoft\Windows\Recent\CustomDestinations" @('*')
Search-Target 'C. Pinned taskbar shortcuts' `
    "$A\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar" @('*.lnk')
Search-Target 'C2. Quick Launch' `
    "$A\Microsoft\Internet Explorer\Quick Launch" @('*.lnk')
Search-Target 'C3. Start menu (user)' `
    "$A\Microsoft\Windows\Start Menu" @('*.lnk') -Recurse
Search-Target 'C4. Start menu (all users)' `
    "${env:ProgramData}\Microsoft\Windows\Start Menu" @('*.lnk') -Recurse
Search-Target 'C5. Desktop shortcuts' `
    "$U\Desktop" @('*.lnk')
Search-Target 'C6. Public desktop shortcuts' `
    "${env:PUBLIC}\Desktop" @('*.lnk')
Search-Target 'C7. Recent items' `
    "$A\Microsoft\Windows\Recent" @('*.lnk')
Search-Target 'D. Start tile / notification caches' `
    "$L\Microsoft\Windows\Caches" @('*') -Recurse
Search-Target 'D2. Notifications' `
    "$L\Microsoft\Windows\Notifications" @('*') -Recurse

Write-Section 'E. Registry (scoped)'
foreach ($root in @(
    'HKCU:\Software\Classes\AppUserModelId',
    'HKLM:\Software\Classes\AppUserModelId',
    'HKCU:\Software\Classes\Applications',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Taskband',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Search\JumpLists',
    'HKCU:\Software\Microsoft\Windows\Shell\BagMRU'
)) {
    if (Test-Path -LiteralPath $root) {
        Write-Host "  walking $root" -ForegroundColor DarkGray
        Search-Registry -Root $root -MaxDepth 4
    } else {
        Write-Host "  (missing) $root" -ForegroundColor DarkGray
    }
}

Write-Section 'SUMMARY'
Write-Host ("  total hits:   {0}" -f $hitCount) -ForegroundColor $(if ($hitCount) {'Green'} else {'Yellow'})
Write-Host ("  locked files: {0}" -f $lockCount) -ForegroundColor $(if ($lockCount) {'Yellow'} else {'Gray'})

if ($prioritized.Count -gt 0) {
    Write-Section 'PRIORITIZE THESE'
    $ranked = $prioritized | Group-Object Kind | Sort-Object Count -Descending
    foreach ($g in $ranked) {
        Write-Host ("`n  [{0}] x{1}" -f $g.Name, $g.Count) -ForegroundColor Yellow
        $g.Group | Select-Object -First 6 | ForEach-Object {
            Write-Host ("     - {0}" -f $_.Path) -ForegroundColor Gray
            Write-Host ("       {0}" -f $_.Why) -ForegroundColor DarkGray
        }
    }
} else {
    Write-Host "`n  No hits anywhere on this profile." -ForegroundColor Yellow
    Write-Host "  -> Test on a FRESH user account / clean VM. If the icon is correct there," -ForegroundColor Gray
    Write-Host "     this profile is contaminated; the build is fine." -ForegroundColor Gray
}

Write-Host "`nNext steps if cache hits found:" -ForegroundColor Cyan
Write-Host "  1. Close Hyperia." -ForegroundColor Gray
Write-Host "  2. del /a `"%LOCALAPPDATA%\IconCache.db`"" -ForegroundColor Gray
Write-Host "  3. del /a `"%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db`"" -ForegroundColor Gray
Write-Host "  4. taskkill /f /im explorer.exe  &  start explorer.exe" -ForegroundColor Gray
Write-Host "  (or just reboot after steps 2-3)" -ForegroundColor Gray
Write-Host "`nIf a .lnk target = electron.exe or a dead path -> delete that .lnk; it is" -ForegroundColor Cyan
Write-Host "carrying the poisoned AUMID. Re-pin from the freshly installed app." -ForegroundColor Gray

Remove-Variable wsh -ErrorAction SilentlyContinue
[Runtime.InteropServices.RuntimeInformation] | Out-Null
