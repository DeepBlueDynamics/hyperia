import type {BrowserWindow} from 'electron';

import Config from 'electron-store';

export const defaults = {
  windowPosition: [50, 50] as [number, number],
  windowSize: [540, 380] as [number, number],
  lastCwd: ''
};

// local storage
const cfg = new Config({defaults});

export function get() {
  const position = cfg.get('windowPosition', defaults.windowPosition);
  const size = cfg.get('windowSize', defaults.windowSize);
  return {position, size};
}
export function recordState(win: BrowserWindow) {
  cfg.set('windowPosition', win.getPosition());
  cfg.set('windowSize', win.getSize());
}

// Last directory the user was in (#101), so a new window's first pane — which
// has no active pane to inherit from — opens there, across restarts too.
// Writes are debounced: every `cd` reports a new cwd.
let lastCwd: string | undefined;
let lastCwdTimer: ReturnType<typeof setTimeout> | undefined;

export function getLastCwd(): string {
  if (lastCwd === undefined) {
    lastCwd = cfg.get('lastCwd', defaults.lastCwd);
  }
  return lastCwd;
}

export function recordLastCwd(cwd: string) {
  if (!cwd || cwd === getLastCwd()) {
    return;
  }
  lastCwd = cwd;
  if (lastCwdTimer) {
    clearTimeout(lastCwdTimer);
  }
  lastCwdTimer = setTimeout(() => {
    lastCwdTimer = undefined;
    cfg.set('lastCwd', lastCwd);
  }, 1000);
}
