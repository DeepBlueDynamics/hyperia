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

  return lines.filter((d) => {
    const lower = d.toLowerCase();
    // Skip Docker Desktop WSL backends and blank entries
    return !lower.includes('docker') && !lower.includes('(default)') && d.length > 0;
  });
}

function detectWindows(): DetectedProfile[] {
  const profiles: DetectedProfile[] = [];

  // PowerShell 7 (pwsh)
  const ps7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  if (existsSync(ps7)) {
    profiles.push({name: 'PowerShell', config: {shell: ps7, shellArgs: []}});
  }

  // PowerShell 5 (built-in Windows)
  const ps5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  if (existsSync(ps5)) {
    profiles.push({name: 'PowerShell 5', config: {shell: ps5, shellArgs: []}});
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

  // WSL distros — only the ones actually installed
  const wslExe = 'C:\\Windows\\System32\\wsl.exe';
  if (existsSync(wslExe)) {
    const distros = detectWslDistros();
    for (const distro of distros) {
      profiles.push({
        name: `WSL: ${distro}`,
        config: {shell: wslExe, shellArgs: ['-d', distro]}
      });
    }
  }

  // Claude Code (Windows)
  const claudeInPath = safeExec('where claude').trim();
  if (claudeInPath && existsSync(claudeInPath.split('\n')[0].trim())) {
    if (existsSync(cmd)) {
      profiles.push({name: 'Claude Code', config: {shell: cmd, shellArgs: ['/c', 'claude']}});
    }
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

  return profiles;
}

/**
 * Detect all available shells on the current system.
 * Returns only shells that are actually installed and runnable.
 */
export function detectProfiles(): DetectedProfile[] {
  try {
    return process.platform === 'win32' ? detectWindows() : detectUnix();
  } catch (err) {
    console.error('[hyperia] shell detection failed:', err);
    return [];
  }
}

/**
 * Pick the best default profile name from a detected list.
 */
export function pickDefaultProfile(profiles: DetectedProfile[]): string {
  if (profiles.length === 0) return 'default';

  const preferred =
    process.platform === 'win32' ? ['PowerShell', 'PowerShell 5', 'CMD', 'Git Bash'] : ['zsh', 'bash', 'fish'];

  for (const name of preferred) {
    if (profiles.find((p) => p.name === name)) return name;
  }

  return profiles[0].name;
}
