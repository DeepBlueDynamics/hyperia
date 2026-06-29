// Persist + restore the main window's last position, size, and chrome state
// (maximize / fullscreen) across launches. Multi-display aware: if the saved
// display has been disconnected, we fall back gracefully to a default that
// is guaranteed to land on a visible monitor.
//
// State file: ~/.hyperia/window-state.json

import {readFileSync, writeFileSync, mkdirSync} from 'fs';
import {homedir} from 'os';
import {dirname, join} from 'path';

import {screen} from 'electron';
import type {BrowserWindow} from 'electron';

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  displayId?: number;
  isMaximized?: boolean;
  isFullScreen?: boolean;
}

const STATE_PATH = join(homedir(), '.hyperia', 'window-state.json');
const SAVE_DEBOUNCE_MS = 400;
// Require at least this much of the window to be inside *some* attached
// display's work area for the saved bounds to be considered usable.
const MIN_VISIBLE_PX = 100;

function readState(): WindowState | null {
  try {
    const raw = readFileSync(STATE_PATH, 'utf8');
    const s = JSON.parse(raw) as WindowState;
    if (typeof s.width === 'number' && typeof s.height === 'number') return s;
  } catch {
    /* file missing or corrupt — fall through to defaults */
  }
  return null;
}

function writeState(s: WindowState): void {
  try {
    mkdirSync(dirname(STATE_PATH), {recursive: true});
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    console.warn('[window-state] save failed:', e);
  }
}

// Does the saved rect overlap any attached display by at least MIN_VISIBLE_PX
// on each axis? If a saved display was unplugged, this guards against the
// window restoring off-screen.
function boundsAreVisible(x: number, y: number, w: number, h: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    const ox = Math.max(x, wa.x);
    const oy = Math.max(y, wa.y);
    const ex = Math.min(x + w, wa.x + wa.width);
    const ey = Math.min(y + h, wa.y + wa.height);
    return ex - ox >= MIN_VISIBLE_PX && ey - oy >= MIN_VISIBLE_PX;
  });
}

export interface RestoreHandle {
  opts: {x?: number; y?: number; width: number; height: number};
  attach: (window: BrowserWindow) => void;
}

/**
 * Build BrowserWindow opts from saved state (falling back to the caller's
 * defaults), and return an `attach` function that wires auto-save and
 * restores maximize / fullscreen once the window is shown.
 *
 *   const r = restoreFor({width, height, x: startX, y: startY});
 *   const win = new BrowserWindow(r.opts);
 *   r.attach(win);
 */
export function restoreFor(defaults: {x?: number; y?: number; width: number; height: number}): RestoreHandle {
  const state = readState();

  const opts: RestoreHandle['opts'] = {
    width: defaults.width,
    height: defaults.height,
    x: defaults.x,
    y: defaults.y
  };

  if (state) {
    // Open it smaller than it was when last closed
    opts.width = Math.max(370, Math.round(state.width * 0.85));
    opts.height = Math.max(190, Math.round(state.height * 0.85));
    if (
      typeof state.x === 'number' &&
      typeof state.y === 'number' &&
      boundsAreVisible(state.x, state.y, state.width, state.height)
    ) {
      const dx = Math.round((state.width - opts.width) / 2);
      const dy = Math.round((state.height - opts.height) / 2);
      opts.x = state.x + dx;
      opts.y = state.y + dy;
    }
    // else: drop x/y so Electron centers on the primary display.
  }

  const attach = (window: BrowserWindow): void => {
    // Restore chrome state once the renderer is ready to show — applying it
    // earlier flickers, applying it later races the user's first interaction.
    if (state) {
      const applyChrome = () => {
        if (window.isDestroyed()) return;
        // Do not auto-maximize or fullscreen on startup to respect "smaller than last closed" request.
      };
      window.once('ready-to-show', applyChrome);
    }

    // Debounced auto-save on any geometry change.
    let timer: NodeJS.Timeout | null = null;
    const save = () => {
      if (window.isDestroyed()) return;
      const isMax = window.isMaximized();
      const isFs = window.isFullScreen();
      // When maximized or fullscreen, getBounds returns the screen rect — use
      // the normal bounds so reverting to "windowed" lands where the user
      // last placed it.
      const bounds =
        (isMax || isFs) && typeof (window as any).getNormalBounds === 'function'
          ? (window as any).getNormalBounds()
          : window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      writeState({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        displayId: display.id,
        isMaximized: isMax,
        isFullScreen: isFs
      });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, SAVE_DEBOUNCE_MS);
    };

    window.on('move', schedule);
    window.on('resize', schedule);
    window.on('maximize', schedule);
    window.on('unmaximize', schedule);
    window.on('enter-full-screen', schedule);
    window.on('leave-full-screen', schedule);
    // Flush on close so the final position is always recorded.
    window.on('close', () => {
      if (timer) clearTimeout(timer);
      save();
    });
  };

  return {opts, attach};
}
