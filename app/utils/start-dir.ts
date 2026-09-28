import {existsSync} from 'fs';
import {isAbsolute} from 'path';

/**
 * Directory for a pane that has no cwd of its own (no active pane to inherit
 * from — e.g. a brand-new window's first tab). Precedence: a launch path
 * argument, the profile's explicit workingDirectory, the last directory the
 * user was in (#101), then home. Anything that isn't an existing absolute
 * path is skipped.
 */
export function pickStartDirectory(
  candidates: {argPath?: string; profileDir?: string; lastCwd?: string},
  home: string,
  exists: (p: string) => boolean = existsSync
): string {
  for (const dir of [candidates.argPath, candidates.profileDir, candidates.lastCwd]) {
    if (dir && isAbsolute(dir) && exists(dir)) {
      return dir;
    }
  }
  return home;
}
