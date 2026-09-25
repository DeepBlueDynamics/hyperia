// The shell the human last launched from a picker, as the main process knows
// it. Kept in its own small file under userData, NEVER in the user's config:
// "last used" is state, and writing it into hyperia.json would silently change
// their configured default (the bug this replaces). The renderer reports it on
// every picker shell launch and once at startup.
import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {app} from 'electron';

let cached: string | undefined | null = null;

const file = () => join(app.getPath('userData'), 'last-shell.json');

export function getLastUsedShell(): string | undefined {
  if (cached === null) {
    try {
      const name = JSON.parse(readFileSync(file(), 'utf8'))?.name;
      cached = typeof name === 'string' && name ? name : undefined;
    } catch {
      cached = undefined;
    }
  }
  return cached;
}

export function setLastUsedShell(name: unknown): void {
  if (typeof name !== 'string' || !name || name === getLastUsedShell()) return;
  cached = name;
  try {
    writeFileSync(file(), JSON.stringify({name}), 'utf8');
  } catch {
    /* userData unwritable: keep the in-memory value */
  }
}
