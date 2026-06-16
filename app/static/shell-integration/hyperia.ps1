# Hyperia PowerShell Integration

# Save old prompt
if (-not (Get-Command -Name "_hyperia_old_prompt" -ErrorAction SilentlyContinue)) {
    $private:oldPrompt = Get-Content -Path "function:\prompt"
    Set-Content -Path "function:\_hyperia_old_prompt" -Value $private:oldPrompt
}

function prompt {
    $exitStatus = $global:LASTEXITCODE
    Write-Host -NoNewline "$([char]0x1b)]133;D;$exitStatus$([char]0x07)"

    if ($env:HYPERIA_CTL_DIR -and (Test-Path "$env:HYPERIA_CTL_DIR\cd")) {
        $targetDir = Get-Content "$env:HYPERIA_CTL_DIR\cd" -Raw
        Remove-Item "$env:HYPERIA_CTL_DIR\cd" -Force -ErrorAction SilentlyContinue
        if (Test-Path $targetDir) {
            Set-Location $targetDir
        }
    }

    $pwdPath = $PWD.ProviderPath
    $pwdUri = $pwdPath.Replace('\', '/')
    if (-not $pwdUri.StartsWith('/')) {
        $pwdUri = "/" + $pwdUri
    }
    Write-Host -NoNewline "$([char]0x1b)]7;file://localhost$pwdUri$([char]0x07)"
    Write-Host -NoNewline "$([char]0x1b)]133;A$([char]0x07)"

    $promptOutput = _hyperia_old_prompt

    Write-Host -NoNewline "$([char]0x1b)]133;B$([char]0x07)"

    return $promptOutput
}

try {
    if (Get-Module -Name PSReadLine) {
        $oldEnterHandler = (Get-PSReadLineKeyHandler | Where-Object Key -eq "Enter" | Select-Object -First 1).ScriptBlock
        Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
            $line = $null
            $cursor = $null
            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
            if ($line -and $line.Trim()) {
                Write-Host -NoNewline "$([char]0x1b)]133;C$([char]0x07)"

                $argv0 = ($line -split '\s+')[0]
                $appPath = ""
                if ($argv0) {
                    $cmd = Get-Command $argv0 -ErrorAction SilentlyContinue
                    if ($cmd) {
                        $appPath = $cmd.Source
                    }
                }

                $b64Cmd = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($line))
                $b64App = if ($appPath) { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($appPath)) } else { "" }
                $b64Argv0 = if ($argv0) { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($argv0)) } else { "" }
                $hyperia_pid = $PID

                Write-Host -NoNewline "$([char]0x1b)]697;cmd=$b64Cmd;app=$b64App;argv0=$b64Argv0;pid=$hyperia_pid$([char]0x07)"
            }
            if ($oldEnterHandler) {
                & $oldEnterHandler
            } else {
                [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
            }
        }
    }
} catch {}
