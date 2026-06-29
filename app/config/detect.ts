/**
 * Shell detection — queries the actual system at startup to build a profiles list
 * containing only shells that are installed and available.
 */
import {execSync} from 'child_process';
import {existsSync} from 'fs';
import process from 'process';

export interface DetectedProfile {
  name: string;
  config: {
    shell: string;
    shellArgs: string[];
  };
}

function safeExec(cmd: string, timeoutMs = 4000): string {
  try {
    const result = execSync(cmd, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });
    // execSync can return Buffer or string depending on encoding option
    if (Buffer.isBuffer(result)) {
      return result.toString('utf8');
    }
    return result as unknown as string;
  } catch {
    return '';
  }
}

function safeExecBuffer(cmd: string, timeoutMs = 4000): Buffer | null {
  try {
    return execSync(cmd, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    }) as unknown as Buffer;
  } catch {
    return null;
  }
}

// Query a PowerShell executable for its real version string (e.g. "7.5.5" or
// "5.1.26100.6584") so the picker can label them distinctly instead of a generic
// "PowerShell" / "Windows PowerShell".
function psVersion(exe: string): string {
  const out = safeExec(`"${exe}" -NoProfile -NonInteractive -Command "$PSVersionTable.PSVersion.ToString()"`).trim();
  const v = out.split(/\r?\n/)[0].trim();
  return /^\d+\.\d+/.test(v) ? v : '';
}

function detectWslDistros(): string[] {
  const wslExe = 'C:\\Windows\\System32\\wsl.exe';
  if (!existsSync(wslExe)) return [];

  // wsl --list --quiet outputs UTF-16 LE on Windows (has null bytes between chars)
  const buf = safeExecBuffer('wsl.exe -l -q');
  if (!buf) return [];

  // Try UTF-16 LE first (the common Windows format for WSL output)
  const raw = buf.toString('utf16le');
  // If it decoded properly, it won't have \0 artifacts — filter them
  let lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, '').trim())
    .filter(Boolean);

  // Sanity check: if lines look garbled, try utf8
  if (lines.length === 0 || lines.some((l) => l.includes('\0'))) {
    lines = buf
      .toString('utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  // Skip Docker Desktop WSL backends + blank entries, and dedup by name so a
  // flaky/garbled `wsl -l` parse can never yield two buttons for one distro.
  const seen = new Set<string>();
  return lines.filter((d) => {
    const lower = d.toLowerCase().trim();
    if (!lower || lower.includes('docker') || lower.includes('(default)')) return false;
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

function detectWindows(): DetectedProfile[] {
  const profiles: DetectedProfile[] = [];

  // PowerShell 7 (pwsh) — labeled with its real version, e.g. "PowerShell 7.5.5".
  const ps7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  if (existsSync(ps7)) {
    const v = psVersion(ps7);
    profiles.push({name: v ? `PowerShell ${v}` : 'PowerShell', config: {shell: ps7, shellArgs: []}});
  }

  // Windows PowerShell 5.x (built-in) — also labeled by version, e.g. "PowerShell 5.1.x".
  const ps5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  if (existsSync(ps5)) {
    const v = psVersion(ps5);
    profiles.push({name: v ? `PowerShell ${v}` : 'PowerShell 5', config: {shell: ps5, shellArgs: []}});
  }

  // CMD — always present on Windows
  const cmd = 'C:\\Windows\\System32\\cmd.exe';
  if (existsSync(cmd)) {
    profiles.push({name: 'CMD', config: {shell: cmd, shellArgs: []}});
  }

  // Git Bash
  const gitBashCandidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
  for (const p of gitBashCandidates) {
    if (existsSync(p)) {
      profiles.push({name: 'Git Bash', config: {shell: p, shellArgs: ['--login', '-i']}});
      break;
    }
  }

  // WSL — one profile per actually-installed distro (from `wsl -l -q`).
  for (const distro of detectWslDistros()) {
    profiles.push({
      name: `WSL: ${distro}`,
      config: {shell: 'C:\\Windows\\System32\\wsl.exe', shellArgs: ['-d', distro]}
    });
  }

  // Claude Code (Windows)
  const claudeInPath = safeExec('where claude').trim();
  if (claudeInPath && existsSync(claudeInPath.split('\n')[0].trim())) {
    if (existsSync(cmd)) {
      profiles.push({name: 'Claude Code', config: {shell: cmd, shellArgs: ['/c', 'claude']}});
    }
  }

  // Nemesis8 agent launcher (Windows). Installed → runs `nemesis8` (its GUI
  // launcher). NOT installed → the button instead opens a PowerShell that installs
  // it from nemesis8.nuts.services (window stays open to show progress).
  const n8WhereNem = safeExec('where nemesis8').trim();
  const n8PathWin = n8WhereNem || safeExec('where n8').trim();
  const n8Installed = !!(n8PathWin && existsSync(n8PathWin.split('\n')[0].trim()));
  // Match `powershell -c "irm ... | iex"` (prefer Windows PowerShell 5.x); -NoExit
  // keeps the pane open so the install output stays visible.
  const psInstaller = existsSync(ps5) ? ps5 : existsSync(ps7) ? ps7 : '';
  if (n8Installed && existsSync(cmd)) {
    const n8Bin = n8WhereNem ? 'nemesis8' : 'n8';
    profiles.push({name: 'Nemesis8', config: {shell: cmd, shellArgs: ['/c', n8Bin]}});
    profiles.push({name: 'Nemesis8 Danger', config: {shell: cmd, shellArgs: ['/c', `${n8Bin} --danger`]}});
  } else if (psInstaller) {
    profiles.push({
      name: 'Nemesis8',
      config: {
        shell: psInstaller,
        shellArgs: ['-NoExit', '-c', 'irm https://nemesis8.nuts.services/install.ps1 | iex']
      }
    });
  }

  return profiles;
}

function detectUnix(): DetectedProfile[] {
  const profiles: DetectedProfile[] = [];

  // zsh
  if (existsSync('/bin/zsh')) {
    profiles.push({name: 'zsh', config: {shell: '/bin/zsh', shellArgs: ['--login']}});
  }

  // bash
  if (existsSync('/bin/bash')) {
    profiles.push({name: 'bash', config: {shell: '/bin/bash', shellArgs: ['--login']}});
  }

  // fish — check common install locations
  const fishPaths = ['/usr/local/bin/fish', '/opt/homebrew/bin/fish', '/usr/bin/fish'];
  for (const p of fishPaths) {
    if (existsSync(p)) {
      profiles.push({name: 'fish', config: {shell: p, shellArgs: []}});
      break;
    }
  }

  // Claude Code (macOS/Linux)
  const claudePath = safeExec('which claude').trim();
  if (claudePath && existsSync(claudePath)) {
    const defaultShell = profiles[0]?.config.shell || '/bin/zsh';
    profiles.push({name: 'Claude Code', config: {shell: defaultShell, shellArgs: ['-l', '-c', 'claude']}});
  }

  // Nemesis8 agent launcher (macOS/Linux). Installed → runs `nemesis8` (GUI
  // launcher). NOT installed → opens a shell that installs it from
  // nemesis8.nuts.services, then drops into a login shell.
  const n8WhichNem = safeExec('which nemesis8').trim();
  const n8Bin = n8WhichNem ? 'nemesis8' : safeExec('which n8').trim() ? 'n8' : '';
  const unixShell = profiles[0]?.config.shell || '/bin/bash';
  if (n8Bin) {
    profiles.push({name: 'Nemesis8', config: {shell: unixShell, shellArgs: ['-l', '-c', n8Bin]}});
    profiles.push({name: 'Nemesis8 Danger', config: {shell: unixShell, shellArgs: ['-l', '-c', `${n8Bin} --danger`]}});
  } else {
    profiles.push({
      name: 'Nemesis8',
      config: {
        shell: unixShell,
        shellArgs: ['-l', '-c', 'curl -fsSL https://nemesis8.nuts.services/install.sh | sh; exec "$SHELL" -l']
      }
    });
  }

  return profiles;
}

/**
 * Detect all available shells on the current system.
 * Returns only shells that are actually installed and runnable.
 */
// Cache the result: detection spawns processes (incl. a PowerShell version probe
// that's slow and occasionally times out → inconsistent labels). Running it once
// keeps names STABLE so repeated config reloads can't spawn duplicate buttons.
let _cachedProfiles: DetectedProfile[] | null = null;
export function detectProfiles(): DetectedProfile[] {
  if (_cachedProfiles) return _cachedProfiles;
  try {
    _cachedProfiles = process.platform === 'win32' ? detectWindows() : detectUnix();
  } catch (err) {
    console.error('[hyperia] shell detection failed:', err);
    _cachedProfiles = [];
  }
  return _cachedProfiles;
}

/**
 * Pick the best default profile name from a detected list.
 */
export function pickDefaultProfile(profiles: DetectedProfile[]): string {
  if (profiles.length === 0) return 'default';

  const preferred =
    process.platform === 'win32' ? ['PowerShell', 'PowerShell 5', 'CMD', 'Git Bash'] : ['zsh', 'bash', 'fish'];

  for (const name of preferred) {
    // Match exact OR by prefix so versioned labels ("PowerShell 7.5.5") still
    // resolve to the "PowerShell" preference. Returns the actual (versioned) name.
    const found = profiles.find((p) => p.name === name || p.name.toLowerCase().startsWith(name.toLowerCase()));
    if (found) return found.name;
  }

  return profiles[0].name;
}
