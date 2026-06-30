# reset-hyperia-windows.ps1
# Bust every Windows cache / shortcut / registration that can pin a stale Hyperia
# icon or hide it from Start + Search. Per-user only — no admin needed.
#
# ORDER:  uninstall Hyperia (Settings > Apps) FIRST, then run this, then install
# the fresh Hyperia-Terminal-x64.exe (the INSTALLER — never run dist\win-unpacked),
# then launch it from the Start menu shortcut. Reboot if the icon is still stale.
#
# It restarts Explorer (brief taskbar flicker). It does NOT touch your other
# taskbar pins, file associations, or any non-Hyperia state.

$ErrorActionPreference = 'SilentlyContinue'
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Note($m) { Write-Host "    $m" -ForegroundColor DarkGray }

# 1. Kill every Hyperia / sidecar process (incl. stray dist\win-unpacked ones) ----
Step "Killing Hyperia + sidecar processes"
Get-Process | Where-Object { $_.ProcessName -match '^(Hyperia|hyperia-sidecar)' } |
  ForEach-Object { Note "kill $($_.ProcessName) ($($_.Id))  $($_.Path)"; Stop-Process -Id $_.Id -Force }
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*hyperia*' } |
  ForEach-Object { Note "kill dev electron ($($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 500

# 2. Remove leftover installed app dirs (default + custom you may have picked) -----
Step "Removing leftover install dirs"
$installDirs = @(
  "$env:LocalAppData\Programs\Hyperia-Terminal",
  "$env:LocalAppData\Programs\hyperia-terminal"
)
# also any folder named Hyperia-Terminal under common custom roots
$installDirs += Get-ChildItem "C:\","$env:UserProfile" -Directory -Filter "Hyperia-Terminal" -Depth 2 -EA SilentlyContinue |
  Where-Object { $_.FullName -notlike "*\Code\*" } | Select-Object -ExpandProperty FullName
foreach ($d in ($installDirs | Select-Object -Unique)) {
  if (Test-Path $d) { Remove-Item $d -Recurse -Force; Note "removed $d" }
}

# 3. Remove ALL Hyperia shortcuts (Start menu, Desktop, taskbar/Start pins) --------
Step "Removing stale Hyperia shortcuts + pins"
$lnkRoots = @(
  "$env:AppData\Microsoft\Windows\Start Menu",
  "$env:ProgramData\Microsoft\Windows\Start Menu",
  "$env:UserProfile\Desktop", "$env:Public\Desktop",
  "$env:AppData\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar",
  "$env:AppData\Microsoft\Internet Explorer\Quick Launch\User Pinned\StartMenu"
)
foreach ($r in $lnkRoots) {
  Get-ChildItem $r -Recurse -Filter "*.lnk" -EA SilentlyContinue |
    Where-Object { $_.Name -match 'hyperia' } |   # matches "Hyperia-Terminal (Ubuntu)" too; NOT Hyper-V
    ForEach-Object { Note "removed $($_.FullName)"; Remove-Item $_.FullName -Force }
}

# 3b. WSL/WSLg-created Start shortcut + its cached icon (Hyperia run inside a distro)
Step "Removing WSL (WSLg) Hyperia entries + icon cache"
# WSLg drops GUI-app shortcuts under Start Menu\Programs\<Distro>\ and caches the
# icon under %TEMP%\WSLDVCPlugin. Already removed inside the distro, but the Windows
# side lingers until cleared here.
Get-ChildItem "$env:AppData\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter "*.lnk" -EA SilentlyContinue |
  Where-Object { $_.Name -match 'hyperia' } |
  ForEach-Object { Note "removed WSL lnk $($_.FullName)"; Remove-Item $_.FullName -Force }
Get-ChildItem "$env:AppData\Microsoft\Windows\Start Menu\Programs" -Directory -EA SilentlyContinue |
  Where-Object { $_.Name -match 'Ubuntu|Debian|WSL|Kali|openSUSE' -and (Get-ChildItem $_.FullName -Filter '*hyper*' -EA SilentlyContinue) } |
  ForEach-Object { Get-ChildItem $_.FullName -Filter '*hyper*' | ForEach-Object { Note "removed $($_.FullName)"; Remove-Item $_.FullName -Force } }
Remove-Item "$env:Temp\WSLDVCPlugin" -Recurse -Force -EA SilentlyContinue
Note "cleared %TEMP%\WSLDVCPlugin icon cache"

# 4. Clean Hyperia-specific registry: App Paths, installer shell verbs, ARP --------
Step "Cleaning Hyperia registry keys"
$regKeys = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\Hyperia-Terminal.exe",
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\electron.exe",
  "HKCU:\Software\Classes\Directory\Background\shell\Hyperia",
  "HKCU:\Software\Classes\Directory\shell\Hyperia",
  "HKCU:\Software\Classes\Drive\shell\Hyperia"
)
foreach ($k in $regKeys) { if (Test-Path $k) { Remove-Item $k -Recurse -Force; Note "removed $k" } }
# Orphaned Add/Remove-Programs entries
Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -EA SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath -EA SilentlyContinue
  if ($p.DisplayName -match 'Hyperia') { Remove-Item $_.PSPath -Recurse -Force; Note "removed ARP '$($p.DisplayName)'" }
}

# 5. Clear Start / AppResolver / Search caches (regenerate harmlessly) -------------
Step "Clearing Start + AppResolver + Search caches"
Remove-Item "$env:LocalAppData\Microsoft\Windows\Caches\*" -Recurse -Force
Remove-Item "$env:LocalAppData\Packages\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\TempState\*" -Recurse -Force
Stop-Process -Name StartMenuExperienceHost, SearchHost -Force   # both respawn

# 6. Clear the icon + thumbnail cache (requires Explorer down) ----------------------
Step "Stopping Explorer to clear icon/thumbnail cache"
Stop-Process -Name explorer -Force
Start-Sleep -Seconds 1
Remove-Item "$env:LocalAppData\IconCache.db" -Force
Remove-Item "$env:LocalAppData\Microsoft\Windows\Explorer\iconcache_*.db" -Force
Remove-Item "$env:LocalAppData\Microsoft\Windows\Explorer\thumbcache_*.db" -Force
& "$env:SystemRoot\System32\ie4uinit.exe" -show

# 7. Restart Explorer ---------------------------------------------------------------
Step "Restarting Explorer"
Start-Process explorer.exe

Write-Host ""
Write-Host "DONE." -ForegroundColor Green
Write-Host "Next: install the FRESH Hyperia-Terminal-x64.exe (the installer), then launch it" -ForegroundColor Green
Write-Host "from the new Start-menu shortcut — NOT dist\win-unpacked\Hyperia-Terminal.exe." -ForegroundColor Green
Write-Host "If the icon is still stale, reboot once (flushes the AppResolver AUMID map)." -ForegroundColor Green
