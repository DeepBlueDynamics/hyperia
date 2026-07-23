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

// ---------------------------------------------------------------------------
// Agent harness catalog — the TUI coding agents nemesis8 knows how to install
// (mirrors ../nemesis8/providers/*.toml). Detection: binary on PATH. Installed
// → a launch profile. Missing (and installable on this host) → an
// "Install <Agent>" profile whose pane RUNS the platform install command, so
// the output stays visible and the agent shows up on the next detection.
// Nemesis8 itself is special-cased below (adds a --danger variant).
// ---------------------------------------------------------------------------
interface AgentDef {
  /** Profile label, e.g. "Claude Code". */
  name: string;
  /** Binaries to look for on PATH, first found wins as the launch command. */
  bins: string[];
  /** POSIX install command (mac/linux). Empty = not installable on unix. */
  installSh?: string;
  /** Windows install command (PowerShell). Empty = not installable on Windows. */
  installPs?: string;
}

const AGENT_DEFS: AgentDef[] = [
  {
    name: 'Claude Code',
    bins: ['claude'],
    installSh: 'npm install -g @anthropic-ai/claude-code',
    installPs: 'npm install -g @anthropic-ai/claude-code'
  },
  // Antigravity ships via Google's own installer (n8 pins a container tarball);
  // no host install string to offer — detect-only.
  {name: 'Antigravity', bins: ['agy', 'antigravity']},
  {
    name: 'Codex',
    bins: ['codex'],
    installSh: 'npm install -g @openai/codex',
    installPs: 'npm install -g @openai/codex'
  },
  {
    name: 'OpenCode',
    bins: ['opencode'],
    installSh: 'npm install -g opencode-ai',
    installPs: 'npm install -g opencode-ai'
  },
  {
    name: 'Grok',
    bins: ['grok'],
    installSh: 'curl -fsSL https://x.ai/cli/install.sh | sh'
    // install.sh only — no Windows installer.
  },
  {
    name: 'Hermes',
    bins: ['hermes'],
    installSh: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | sh'
    // install.sh only — no Windows installer.
  },
  {
    name: 'Pi',
    bins: ['pi'],
    installSh: 'npm install -g @earendil-works/pi-coding-agent --ignore-scripts',
    installPs: 'npm install -g @earendil-works/pi-coding-agent --ignore-scripts'
  }
];

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

// First path in the list that exists on disk, or '' if none. Lets detection try
// several known install locations for one tool instead of hardcoding one.
function firstExisting(paths: (string | null | undefined)[]): string {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return '';
}

// Resolve a bare executable name to its first absolute path via `where` (Windows).
// Returns '' if not found. Catches installs that live only on PATH — winget and
// Microsoft Store pwsh, portable unzips — which no hardcoded folder would find.
function resolveOnPath(bin: string): string {
  const found = safeExec(`where ${bin}`).trim().split(/\r?\n/)[0].trim();
  return found && existsSync(found) ? found : '';
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
  // The install location varies: the 64-bit MSI lands in "Program Files", the
  // 32-bit MSI in "Program Files (x86)", and winget/Store installs are only on
  // PATH. Hardcoding just the 64-bit path meant an x86 install was missed
  // entirely — the "PowerShell" profile then pointed at a nonexistent exe and
  // every pane opened with it silently fell back to Windows PowerShell 5.1.
  // Probe the known folders, then PATH, and take the first that actually exists.
  const ps7 = firstExisting([
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
    resolveOnPath('pwsh')
  ]);
  if (ps7) {
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

  // ── Agent harnesses (Windows) ─────────────────────────────────────────────
  // Detection only: installed (binary on PATH) → launch profile. Missing agents
  // are NOT auto-installed — the picker's "install an agent" view shows the
  // install instructions and the user runs them.
  const whereBin = (bins: string[]): string => {
    for (const b of bins) {
      const found = safeExec(`where ${b}`).trim();
      if (found && existsSync(found.split('\n')[0].trim())) return b;
    }
    return '';
  };
  if (existsSync(cmd)) {
    for (const def of AGENT_DEFS) {
      const bin = whereBin(def.bins);
      if (bin) profiles.push({name: def.name, config: {shell: cmd, shellArgs: ['/c', bin]}});
    }
    // Nemesis8 — installed adds the --danger variant.
    const n8Bin = whereBin(['nemesis8', 'n8']);
    if (n8Bin) {
      profiles.push({name: 'Nemesis8', config: {shell: cmd, shellArgs: ['/c', n8Bin]}});
      profiles.push({name: 'Nemesis8 Danger', config: {shell: cmd, shellArgs: ['/c', `${n8Bin} --danger`]}});
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

  // ── Agent harnesses (macOS/Linux) ─────────────────────────────────────────
  // Detection only: installed (binary on PATH) → launch profile. Missing agents
  // are NOT auto-installed — the picker's "install an agent" view shows the
  // install instructions and the user runs them.
  const unixShell = profiles[0]?.config.shell || '/bin/bash';
  const whichBin = (bins: string[]): string => {
    for (const b of bins) {
      const found = safeExec(`which ${b}`).trim();
      if (found && existsSync(found)) return b;
    }
    return '';
  };
  for (const def of AGENT_DEFS) {
    const bin = whichBin(def.bins);
    if (bin) profiles.push({name: def.name, config: {shell: unixShell, shellArgs: ['-l', '-c', bin]}});
  }
  // Nemesis8 — installed adds the --danger variant.
  const n8Bin = whichBin(['nemesis8', 'n8']);
  if (n8Bin) {
    profiles.push({name: 'Nemesis8', config: {shell: unixShell, shellArgs: ['-l', '-c', n8Bin]}});
    profiles.push({name: 'Nemesis8 Danger', config: {shell: unixShell, shellArgs: ['-l', '-c', `${n8Bin} --danger`]}});
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
