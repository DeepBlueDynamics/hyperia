$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Hyperia.lnk'
Remove-Item $lnk -ErrorAction SilentlyContinue
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = 'C:\Users\kordl\Code\Gnosis\hyperia\dist\win-unpacked\Hyperia.exe'
$s.IconLocation = 'C:\Users\kordl\Code\Gnosis\hyperia\build\icon.ico'
$s.Save()
Write-Host "Shortcut created with icon.ico"
