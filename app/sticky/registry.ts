import type {BrowserWindow} from 'electron';

export const SEARCH_WIN_ID = 'sticky-search-window';

/** Currently-open sticky windows by noteId. */
export const stickyWindows = new Map<string, BrowserWindow>();

/** Active file watch paths by noteId for linked/watched files. */
export const fileWatchPaths = new Map<string, string>();

/** Send stickys-changed event to the search window if it is open. */
export function notifySearchWindowChanged(): void {
  const searchWin = stickyWindows.get(SEARCH_WIN_ID);
  if (searchWin && !searchWin.isDestroyed()) {
    searchWin.webContents.send('stickys-changed');
  }
}
