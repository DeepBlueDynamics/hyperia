import type {BrowserWindow} from 'electron';

/** Present only the terminal windows explicitly selected by app startup. */
export function showStartupWindows(windows: Iterable<BrowserWindow>): void {
  const terminalWindows = Array.from(windows);
  const showIfHidden = (win: BrowserWindow): void => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  for (const win of terminalWindows) {
    win.webContents.once('did-finish-load', () => showIfHidden(win));
  }
  // Terminal-window fallback only. Auxiliary windows own their presentation;
  // showing then re-hiding a sticky can expose its unpainted native surface.
  setTimeout(() => {
    for (const win of terminalWindows) showIfHidden(win);
  }, 2000);
}
