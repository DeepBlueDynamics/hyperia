// The platform's own interactive shell, picked from the DETECTED profiles —
// never a hardcoded path. Used where Hyperia must open "a plain shell" on the
// user's behalf (the picker's install/update [run]) instead of whatever the
// config default happens to be (which may be a custom agent shell).

export type ShellProfile = {name: string; kind?: string; config?: {shell?: string; shellArgs?: string[]}};

const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';

// A config synced between machines can carry the other platform's shells.
// Hide a profile only when its shell path clearly belongs to the OTHER
// platform; bare commands (`ssh`, `wsl`, `docker`) fit anywhere.
export function profileFitsPlatform(p: ShellProfile, windows: boolean): boolean {
  const shell = String(p?.config?.shell || '');
  if (!shell) return true;
  const looksWindows = /\.exe$|\\|^[A-Za-z]:/.test(shell);
  const looksUnix = /^\//.test(shell);
  return windows ? !looksUnix : !looksWindows;
}

const existsOnDisk = (path: string): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('fs') as typeof import('fs')).existsSync(path);
  } catch {
    return true;
  }
};

// Fits this platform AND, for an absolute shell path, is actually installed.
// Old configs carry shells this machine never had (e.g. /bin/zsh on Ubuntu).
export function shellRunnableHere(p: ShellProfile, windows: boolean, exists = existsOnDisk): boolean {
  if (!profileFitsPlatform(p, windows)) return false;
  const shell = String(p?.config?.shell || '');
  const absolute = windows ? /^[A-Za-z]:[\\/]/.test(shell) : shell.startsWith('/');
  return !absolute || exists(shell);
}

// Flags that still mean "just the interactive shell". Anything else (e.g. a
// custom shell wrapping `-Command claude`) is a launcher, not a plain shell.
const INTERACTIVE_FLAGS = new Set(['--login', '-l', '-i', '--interactive', '-nologo', '-login']);

export function isPlainShell(p: ShellProfile, windows: boolean): boolean {
  const shell = p?.config?.shell;
  if (!shell || p.kind) return false;
  if (!profileFitsPlatform(p, windows)) return false;
  return (p.config?.shellArgs || []).every((a) => INTERACTIVE_FLAGS.has(String(a).toLowerCase()));
}

// "PowerShell 7.5.5" -> [7,5,5]; unlabeled sorts lowest.
const versionOf = (name: string): number[] => (name.match(/(\d+(?:\.\d+)*)/)?.[1] || '0').split('.').map(Number);
const newerFirst = (a: ShellProfile, b: ShellProfile) => {
  const va = versionOf(a.name);
  const vb = versionOf(b.name);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] || 0) - (va[i] || 0);
    if (d) return d;
  }
  return 0;
};

/**
 * Windows: newest pwsh, then Windows PowerShell, then cmd, then anything plain.
 * macOS/Linux: the user's login shell (by basename), then zsh, bash, then any.
 */
export function pickNativeShell(profiles: ShellProfile[], windows: boolean, loginShell = ''): ShellProfile | undefined {
  const plain = (profiles || []).filter((p) => isPlainShell(p, windows));
  const byBin = (bins: string[]) =>
    plain.filter((p) => bins.includes(basename(p.config!.shell!).replace(/\.exe$/, ''))).sort(newerFirst)[0];
  if (windows) {
    return byBin(['pwsh']) || byBin(['powershell']) || byBin(['cmd']) || plain[0];
  }
  const login = basename(loginShell);
  return (login && byBin([login])) || byBin(['zsh']) || byBin(['bash']) || plain[0];
}

export const isPowerShell = (p?: ShellProfile) => /^(pwsh|powershell)(\.exe)?$/.test(basename(p?.config?.shell || ''));
