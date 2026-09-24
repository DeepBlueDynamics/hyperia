# Desktop shortcut to a locally built (unpacked) Hyperia, resolved from this
# repo's location, never a hardcoded user path.
$repo = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Hyperia.lnk'
Remove-Item $lnk -ErrorAction SilentlyContinue
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = Join-Path $repo 'dist\win-unpacked\Hyperia.exe'
$s.IconLocation = Join-Path $repo 'build\icon.ico'
$s.Save()
Write-Host "Shortcut created with icon.ico"
