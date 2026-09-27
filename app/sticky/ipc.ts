import {BrowserWindow, dialog, ipcMain, shell} from 'electron';

import {translateContainerPath} from './constants';
import {isSafeExternalUrl} from './external-url';
import {showStickyContextMenu, toggleStickySeeThrough} from './menu';
import {loadStickySeeThrough, readStickyHidden} from './preferences';
import {SEARCH_WIN_ID, stickyWindows} from './registry';
import {readHistory} from './runs/history';
import {N8_INSTALL_URL, n8ConfigPath} from './runs/runners';
import {listOpenPanes, replyError, sidecarRequest} from './runs/sidecar';
import {clearRun, pauseRun, runNow, setRun, startScheduler} from './scheduler';
import {handleStickyHighlight} from './security';
import {readAllNotes} from './store';
import {buildStickysSummary} from './summary';
import type {StickyRun} from './types';
import {closeStickyNote, createStickyNote, hideAllStickys, hideSticky, showAllStickys} from './window';

function registerRunIpc(): void {
  ipcMain.handle('sticky-run-set', (_event, id: string, run: StickyRun) => setRun(id, run, {human: true}));
  ipcMain.handle('sticky-run-clear', (_event, id: string) => clearRun(id));
  ipcMain.handle('sticky-run-now', (_event, id: string) => runNow(id));
  ipcMain.handle('sticky-run-pause', (_event, id: string, paused: boolean) => pauseRun(id, !!paused));
  ipcMain.handle('sticky-run-history', (_event, id: string, limit?: number) =>
    readHistory(id, Number.isInteger(limit) && (limit as number) > 0 ? (limit as number) : 50)
  );
  ipcMain.handle('sticky-run-panes', async () => {
    const r = await listOpenPanes();
    return r.ok ? r.panes : [];
  });
  ipcMain.handle('sticky-n8-status', async () => {
    const extra = {config_path: n8ConfigPath(), install_url: N8_INSTALL_URL};
    const r = await sidecarRequest('GET', '/api/n8/status');
    if (!r.ok) return {installed: false, running: false, providers: [], error: replyError(r), ...extra};
    return {...r.data, ...extra};
  });
  ipcMain.handle('sticky-n8-start', async () => {
    const r = await sidecarRequest('POST', '/api/n8/start', {}, 20000);
    if (!r.ok) return {ok: false, running: false, error: replyError(r)};
    return {ok: !!r.data?.ok, running: !!r.data?.running, error: r.data?.error};
  });
}

export function initSticky(): void {
  ipcMain.on('new-sticky', (_event, options?: {filePath?: string; text?: string}) => {
    createStickyNote({...options, focus: true});
  });

  ipcMain.on('new-sticky-file', (_event, filePath: string) => {
    createStickyNote({filePath, focus: true});
  });

  ipcMain.on('search-stickies', () => {
    createStickyNote({
      id: 'sticky-search-window',
      name: '🔍 Search Stickys',
      color: '#ffffff',
      width: 400,
      height: 500,
      focus: true
    });
  });

  ipcMain.on('sticky-close', (_event, noteId: string) => {
    closeStickyNote(noteId);
  });

  ipcMain.on('hide-all-stickys', () => hideAllStickys());
  ipcMain.on('show-all-stickys', () => showAllStickys());
  ipcMain.on('hide-sticky', (_event, noteId: string) => hideSticky(noteId));
  ipcMain.on('hide-other-stickys', (_event, noteId: string) => hideAllStickys(noteId));

  ipcMain.on('open-matching-stickys', (_event, ids: string[], replace: boolean) => {
    if (replace) {
      for (const id of Array.from(stickyWindows.keys())) {
        if (id === SEARCH_WIN_ID) continue;
        closeStickyNote(id);
      }
    }
    for (const id of Array.isArray(ids) ? ids : []) {
      if (id !== SEARCH_WIN_ID) createStickyNote({id, focus: true});
    }
  });

  ipcMain.on('generate-summary-sticky', () => {
    createStickyNote({text: buildStickysSummary(), focus: true});
  });

  ipcMain.handle('sticky-pick-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const res = await dialog.showOpenDialog(win as BrowserWindow, {properties: ['openDirectory']});
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });

  registerRunIpc();

  startScheduler();
  loadStickySeeThrough();

  ipcMain.on('sticky-toggle-seethrough', () => {
    toggleStickySeeThrough();
  });

  ipcMain.on('sticky-color', (_event, noteId: string, color: string) => {
    const win = stickyWindows.get(noteId);
    if (win && !win.isDestroyed() && color.startsWith('#')) {
      win.setBackgroundColor(color);
    }
  });

  ipcMain.on(
    'sticky-context-menu',
    (
      event,
      noteId: string,
      hasSelection: boolean,
      currentColor: string,
      isFileBound?: boolean,
      link?: string | null
    ) => {
      showStickyContextMenu(event, noteId, hasSelection, currentColor, isFileBound, link);
    }
  );

  ipcMain.on('sticky-open-file', (_event, filePath: string) => {
    void shell.openPath(translateContainerPath(filePath));
  });

  ipcMain.on('sticky-open-external', (_event, url: string) => {
    // Sticky text is agent-writable; only web and mail links may reach the OS handler.
    if (!isSafeExternalUrl(url)) {
      console.warn('[sticky] refused to open non-web link:', String(url).slice(0, 200));
      return;
    }
    void shell.openExternal(url);
  });

  ipcMain.on('sticky-open-web-pane', (_event, url: string) => {
    const stickyWinSet = new Set(stickyWindows.values());
    const target = BrowserWindow.getAllWindows().find(
      (w) => !stickyWinSet.has(w) && !w.isDestroyed() && (w as any).rpc
    );
    if (target)
      (target as unknown as {rpc: {emit: (ch: string, data: unknown) => void}}).rpc.emit('open web pane req', {url});
  });

  ipcMain.on('sticky-open-note', (_event, nameOrId: string) => {
    const notes = readAllNotes();
    const note = notes.find((n) => n.id === nameOrId) ?? notes.find((n) => n.name === nameOrId);
    if (note) createStickyNote({id: note.id, focus: true});
  });

  ipcMain.on('sticky-geom', () => {
    // handled by win.on('moved'/'resized') in window.ts
  });

  ipcMain.handle('sticky-highlight', (event, payload) => handleStickyHighlight(event, payload));

  // Session Restore on Launch (Owned by remote developer — preserved exactly)
  setTimeout(() => {
    const hidden = readStickyHidden();
    for (const note of readAllNotes()) {
      if (note.id === SEARCH_WIN_ID || note.filePath) continue;
      if (note.open && !stickyWindows.has(note.id)) {
        createStickyNote({id: note.id, startHidden: hidden});
      }
    }
  }, 400);
}
