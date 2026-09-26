import type {Stats} from 'fs';

/** "Open in …" label naming the OS file browser for the given platform. */
export function fileBrowserLabel(platform: string = process.platform): string {
  if (platform === 'win32') return 'Open in Explorer';
  if (platform === 'darwin') return 'Open in Finder';
  return 'Open in File Manager';
}

// An ssh/container pane reports a cwd that may not exist on this machine;
// only offer the action for a real local directory.
export function isLocalDir(dir: string | null | undefined, statSync: (p: string) => Stats): boolean {
  if (!dir || typeof dir !== 'string') return false;
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
