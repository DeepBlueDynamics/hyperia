# Hyperia installer for Windows (x64)
# Usage: powershell -c "irm https://hyperia.nuts.services/install.ps1 | iex"
$ErrorActionPreference = 'Stop'

$repo = 'DeepBlueDynamics/hyperia'
$apiUrl = "https://api.github.com/repos/$repo/releases/latest"

Write-Host '==> Fetching latest Hyperia release...'
$release = Invoke-RestMethod -Uri $apiUrl -Headers @{ 'User-Agent' = 'hyperia-installer' }
$asset = $release.assets | Where-Object { $_.name -like '*x64.exe' } | Select-Object -First 1

if (-not $asset) {
    Write-Host "No Windows installer found in the latest release."
    Write-Host "Check https://github.com/$repo/releases for manual download."
    exit 1
}

$version = $release.tag_name
$url = $asset.browser_download_url
$installer = Join-Path $env:TEMP "Hyperia-$version-setup.exe"

Write-Host "==> Downloading Hyperia $version..."

$req = [System.Net.HttpWebRequest]::Create($url)
$req.UserAgent = 'hyperia-installer'
$req.AllowAutoRedirect = $true
$resp = $req.GetResponse()
$total = $resp.ContentLength
$src  = $resp.GetResponseStream()
$dst  = [System.IO.File]::Create($installer)

$buf        = New-Object byte[] 65536
$downloaded = [long]0
$sw         = [System.Diagnostics.Stopwatch]::StartNew()
$lastBytes  = [long]0
$lastTick   = $sw.ElapsedMilliseconds

try {
    while (($read = $src.Read($buf, 0, $buf.Length)) -gt 0) {
        $dst.Write($buf, 0, $read)
        $downloaded += $read

        $now = $sw.ElapsedMilliseconds
        if ($now - $lastTick -ge 250) {
            $bw      = ($downloaded - $lastBytes) / (($now - $lastTick) / 1000.0)
            $mbps    = '{0:F1}' -f ($bw / 1MB)
            $dlMB    = '{0:F1}' -f ($downloaded / 1MB)
            $totalMB = if ($total -gt 0) { '{0:F1}' -f ($total / 1MB) } else { '?' }
            $pct     = if ($total -gt 0) { '{0,3}' -f [int]($downloaded * 100 / $total) } else { '  ?' }
            Write-Host "`r    $dlMB / $totalMB MB   $mbps MB/s   $pct%" -NoNewline
            $lastBytes = $downloaded
            $lastTick  = $now
        }
    }
} finally {
    $dst.Close()
    $src.Close()
    $resp.Close()
}

$elapsed = $sw.Elapsed.TotalSeconds
$avgMBps = '{0:F1}' -f ($downloaded / 1MB / $elapsed)
Write-Host "`r    $([math]::Round($downloaded/1MB,1)) MB in $([math]::Round($elapsed,1))s  ($avgMBps MB/s avg)          "

Write-Host '==> Running installer...'
Start-Process -FilePath $installer -Wait

Remove-Item $installer -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "Hyperia $version installed."
