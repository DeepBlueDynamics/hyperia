import {existsSync} from 'fs';
import {basename, resolve} from 'path';

import {app, BrowserWindow, screen} from 'electron';

import isDev from 'electron-is-dev';

import {generateNoteName, nextColor, translateContainerPath} from './constants';
import {startFileWatch, stopFileWatch} from './file-watch';
import {getStickyDefaultSize, stickyOpacityNow} from './preferences';
import {SEARCH_WIN_ID, stickyWindows} from './registry';
import {setSchedulerNoteOpener} from './scheduler';
import {installStickySecurityGuards, STICKY_WEB_PREFERENCES} from './security';
import {deleteNote, getNote, readAllNotes, updateNote, upsertNote} from './store';
import type {StickyRef} from './types';
import {
  anyStickyHidden,
  anyStickyVisible,
  hideAllStickys,
  hideSticky,
  otherStickysVisible,
  register,
  reveal,
  showAllStickys,
  unregister
} from './visibility';

export {anyStickyHidden, anyStickyVisible, hideAllStickys, hideSticky, otherStickysVisible, showAllStickys};

let devToolsFirst = false;

export function openUrlInWebPane(fromWin: BrowserWindow | null, url: string): void {
  const target = BrowserWindow.getAllWindows().find(
    (w) => w !== fromWin && !w.isDestroyed() && (w as unknown as {rpc?: unknown}).rpc
  );
  (target as unknown as {rpc?: {emit: (ch: string, p: unknown) => void}})?.rpc?.emit('open web pane req', {url});
}

export function resolveStickyHtmlPath(isDevMode: boolean = isDev, appPath?: string): string {
  const baseDir = isDevMode ? resolve(__dirname, '..') : appPath || (app ? app.getAppPath() : __dirname);
  return resolve(baseDir, 'sticky.html');
}

export function createStickyNote(
  options: {
    id?: string;
    name?: string;
    filePath?: string;
    text?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    color?: string;
    startHidden?: boolean;
    creator?: string;
    focus?: boolean;
  } = {}
) {
  if (options.filePath) {
    options.filePath = translateContainerPath(options.filePath);
    if (!existsSync(options.filePath)) {
      return {
        win: null as BrowserWindow | null,
        id: options.id || '',
        name: basename(options.filePath),
        error: `Cannot read file '${options.filePath}' — not reachable from the Hyperia host. If you're running in a container or on another machine, the path isn't accessible here; pass the content via sticky_note_create instead, or use a host-reachable path.`
      };
    }
  }

  // Reject open requests for unpersisted IDs (no resurrection of deleted/missing notes)
  // Exemption only for SEARCH_WIN_ID or filePath code window; passing text/creator must not recreate missing persistent id
  if (options.id && options.id !== SEARCH_WIN_ID && !options.filePath) {
    const existingPersisted = getNote(options.id);
    if (!existingPersisted) {
      return {
        win: null as BrowserWindow | null,
        id: options.id,
        name: '',
        error: 'Note not found'
      };
    }
  }

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  const noteId = options.id || `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const existing = stickyWindows.get(noteId);
  if (existing && !existing.isDestroyed()) {
    if (!options.startHidden) {
      reveal(noteId, !!options.focus);
    }
    return {win: existing, id: noteId, name: getNote(noteId)?.name || noteId};
  }

  const savedNote = options.id ? getNote(options.id) : undefined;
  if (savedNote?.source?.path) {
    savedNote.source.path = translateContainerPath(savedNote.source.path);
  }

  const defaultSize = getStickyDefaultSize();
  let width = options.width || savedNote?.width || defaultSize.width;
  let height = options.height || savedNote?.height || defaultSize.height;

  const hasPlacedPos = options.x != null || options.y != null || savedNote?.x != null || savedNote?.y != null;
  let x = options.x ?? savedNote?.x ?? Math.round(cursor.x - width / 2);
  let y = options.y ?? savedNote?.y ?? Math.round(cursor.y - height / 2);

  const targetDisplay = hasPlacedPos ? screen.getDisplayNearestPoint({x, y}) : display;
  const wa = targetDisplay.workArea;
  width = Math.min(width, wa.width);
  height = Math.min(height, wa.height);
  width = Math.max(width, 220);
  height = Math.max(height, 170);
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));

  const existingNames = readAllNotes().map((n) => n.name || '');
  const displayName = options.name || savedNote?.name || generateNoteName(existingNames);
  const colorHex = options.color || savedNote?.color || nextColor().bg;

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 120,
    minHeight: 90,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    show: false,
    backgroundColor: colorHex,
    webPreferences: STICKY_WEB_PREFERENCES
  });

  installStickySecurityGuards(win.webContents);

  if (!options.filePath && noteId !== 'sticky-search-window') {
    const current = getNote(noteId) || {
      id: noteId,
      name: displayName,
      color: colorHex,
      text: options.text || '',
      x,
      y,
      width,
      height,
      created_at: new Date().toISOString(),
      creator: options.creator
    };
    upsertNote({...current, name: displayName, x, y, width, height, color: colorHex, open: true});
  }

  stickyWindows.set(noteId, win);

  // Register in visibility controller (manages desiredVisible, focusPending, ready-to-show, show guard)
  register(noteId, win, {startHidden: options.startHidden, focus: options.focus});

  const htmlPath = resolveStickyHtmlPath();
  const queryParams = new URLSearchParams();
  queryParams.set('id', noteId);
  queryParams.set('color', colorHex);
  queryParams.set('name', displayName);
  if (options.filePath) queryParams.set('file', options.filePath);
  if (noteId === 'sticky-search-window') queryParams.set('mode', 'search');
  void win.loadFile(htmlPath, {search: queryParams.toString()});

  win.once('ready-to-show', () => {
    if (savedNote?.source?.kind === 'file' && savedNote.source.path) {
      startFileWatch(noteId, savedNote.source.path);
    } else if (options.filePath) {
      startFileWatch(noteId, options.filePath);
    }

    if (devToolsFirst) {
      devToolsFirst = false;
      win.webContents.openDevTools({mode: 'detach'});
    }
  });

  let geomReady = false;
  setTimeout(() => {
    geomReady = true;
  }, 1200);
  const saveGeom = () => {
    if (!geomReady) return;
    if (options.filePath || noteId === 'sticky-search-window') return;
    const bounds = win.getBounds();
    const note = getNote(noteId);
    if (note) {
      upsertNote({...note, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height});
    }
  };
  win.on('moved', saveGeom);
  win.on('resized', saveGeom);

  if (!win.isDestroyed()) win.setOpacity(stickyOpacityNow());
  win.on('focus', () => {
    if (!win.isDestroyed()) win.moveTop();
  });

  win.on('closed', () => {
    unregister(noteId);
    stickyWindows.delete(noteId);
    stopFileWatch(noteId);
  });

  return {win, id: noteId, name: displayName};
}

// Wire opener into scheduler to break cycles
setSchedulerNoteOpener(createStickyNote);

export function closeStickyNote(noteId: string): boolean {
  const note = getNote(noteId);
  const win = stickyWindows.get(noteId);
  if (note || win) {
    if (note) {
      upsertNote({...note, last_closed_at: new Date().toISOString(), open: false});
    }
    if (win && !win.isDestroyed()) {
      win.close();
    }
    return true;
  }
  return false;
}

export function deleteStickyNote(noteId: string): boolean {
  const deleted = deleteNote(noteId);
  const win = stickyWindows.get(noteId);
  if (win && !win.isDestroyed()) {
    win.close();
  }
  unregister(noteId);
  stickyWindows.delete(noteId);
  return deleted;
}

export function updateStickyNote(noteId: string, text: string): boolean {
  return updateNote(noteId, text);
}

export function listOpenStickyRefs(): StickyRef[] {
  const refs: StickyRef[] = [];
  for (const [id, win] of stickyWindows) {
    if (id === SEARCH_WIN_ID || !win || win.isDestroyed()) {
      continue;
    }
    if (!getNote(id)) {
      continue;
    }
    const b = win.getBounds();
    refs.push({id, x: b.x, y: b.y, width: b.width, height: b.height, open: true});
  }
  return refs;
}
