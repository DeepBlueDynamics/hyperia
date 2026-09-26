import {existsSync} from 'fs';

type Profile = {name: string; config?: {shell?: string}};

// On macOS/Linux, drop profiles this machine can't run: Windows shells, and
// path-like shells that aren't installed (old configs seeded every platform's).
// Bare commands (`ssh`, `docker`) resolve via PATH and are kept.
export function dropForeignShells<T extends Profile>(
  profiles: T[],
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync
): T[] {
  if (platform === 'win32') return profiles;
  return profiles.filter((p) => {
    const shell = String(p?.config?.shell || '');
    if (/\\|^[A-Za-z]:|\.exe$/i.test(shell)) return false;
    return !shell.includes('/') || exists(shell);
  });
}
