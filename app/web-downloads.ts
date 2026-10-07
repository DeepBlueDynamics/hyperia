// Downloads started from web panes. Without this Electron either pops an OS
// Save dialog or saves silently — no progress, no record. Here every download
// goes straight to the OS Downloads folder (unique name, no dialog), its
// progress is pushed to the window that hosts the pane, and a short history is
// kept in ~/.hyperia/downloads.json so the Downloads list survives a restart.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {BrowserWindow, app, ipcMain, shell} from 'electron';
import type {DownloadItem, Session, WebContents} from 'electron';

import {uniqueDownloadName} from './utils/download-name';

export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';

export interface DownloadRecord {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  received: number;
  total: number;
  state: DownloadState;
  startedAt: number;
  endedAt?: number;
  paneUid?: string;
}

const HISTORY_MAX = 100;
// Progress pushes per download, at most this often.
const PUSH_MS = 250;

const records: DownloadRecord[] = [];
const items = new Map<string, DownloadItem>();
// Windows that should hear about a download (the one hosting its pane).
const owners = new Map<string, number>();
let seq = 0;
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

const historyPath = () => join(app.getPath('home'), '.hyperia', 'downloads.json');

function loadHistory(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(historyPath(), 'utf8'));
    if (!Array.isArray(raw)) return;
    for (const r of raw.slice(0, HISTORY_MAX)) {
      if (!r || typeof r.id !== 'string' || typeof r.savePath !== 'string') continue;
      // Anything still running when we last quit didn't finish.
      const state: DownloadState = r.state === 'progressing' || r.state === 'paused' ? 'interrupted' : r.state;
      records.push({...r, state});
    }
  } catch {
    /* no history yet */
  }
}

function saveHistorySoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(dirname(historyPath()), {recursive: true});
      writeFileSync(historyPath(), JSON.stringify(records.slice(0, HISTORY_MAX), null, 2));
    } catch (err) {
      console.warn('[downloads] could not save history:', err);
    }
  }, 500);
}

function pushSoon(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushAll();
  }, PUSH_MS);
}

function pushAll(): void {
  const list = records.slice(0, HISTORY_MAX);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    // Each window's toasts show only its own downloads; the full list goes along
    // for the Downloads panel.
    const mine = list.filter((r) => owners.get(r.id) === win.id).map((r) => r.id);
    win.webContents.send('web-downloads:update', {downloads: list, mine});
  }
}

function update(rec: DownloadRecord, item: DownloadItem): void {
  rec.received = item.getReceivedBytes();
  rec.total = item.getTotalBytes();
}

/**
 * Hook downloads on the web-pane session. `ownerOf` maps the page that started
 * a download to its pane and host window (null = unknown; the focused window
 * gets it).
 */
export function attachWebDownloads(
  sess: Session,
  ownerOf: (wc: WebContents | undefined) => {win: BrowserWindow; uid: string} | null
): void {
  loadHistory();
  sess.on('will-download', (_e, item, wc) => {
    const dir = app.getPath('downloads');
    const inFlight = new Set(
      records.filter((r) => r.state === 'progressing' || r.state === 'paused').map((r) => r.savePath)
    );
    const name = uniqueDownloadName(item.getFilename(), (c) => {
      const p = join(dir, c);
      return existsSync(p) || inFlight.has(p);
    });
    const savePath = join(dir, name);
    // Setting the path here skips the OS Save dialog.
    item.setSavePath(savePath);

    const owner = ownerOf(wc);
    const id = `dl-${Date.now().toString(36)}-${++seq}`;
    const rec: DownloadRecord = {
      id,
      filename: name,
      url: item.getURL(),
      savePath,
      received: 0,
      total: item.getTotalBytes(),
      state: 'progressing',
      startedAt: Date.now(),
      paneUid: owner?.uid
    };
    records.unshift(rec);
    if (records.length > HISTORY_MAX) records.length = HISTORY_MAX;
    items.set(id, item);
    const win = owner?.win ?? BrowserWindow.getFocusedWindow();
    if (win) owners.set(id, win.id);

    item.on('updated', (_ev, state) => {
      update(rec, item);
      rec.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      pushSoon();
    });
    item.once('done', (_ev, state) => {
      update(rec, item);
      rec.state = state;
      rec.endedAt = Date.now();
      items.delete(id);
      saveHistorySoon();
      pushAll();
    });
    saveHistorySoon();
    pushAll();
  });
}

let inited = false;

/** Register the renderer IPC. Idempotent. */
export function initWebDownloads(): void {
  if (inited) return;
  inited = true;
  loadHistory();

  ipcMain.handle('web-downloads:list', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const list = records.slice(0, HISTORY_MAX);
    return {downloads: list, mine: list.filter((r) => owners.get(r.id) === win?.id).map((r) => r.id)};
  });

  ipcMain.handle('web-downloads:action', async (_e, msg: {id?: string; action: string}) => {
    const rec = records.find((r) => r.id === msg?.id);
    const item = msg?.id ? items.get(msg.id) : undefined;
    switch (msg?.action) {
      case 'cancel':
        item?.cancel();
        return {ok: !!item};
      case 'pause':
        item?.pause();
        return {ok: !!item};
      case 'resume':
        if (item?.canResume()) item.resume();
        return {ok: !!item};
      case 'open': {
        if (!rec || !existsSync(rec.savePath)) return {ok: false, error: 'File is gone'};
        const err = await shell.openPath(rec.savePath);
        return err ? {ok: false, error: err} : {ok: true};
      }
      case 'show':
        if (rec && existsSync(rec.savePath)) shell.showItemInFolder(rec.savePath);
        else void shell.openPath(app.getPath('downloads'));
        return {ok: true};
      case 'folder':
        await shell.openPath(app.getPath('downloads'));
        return {ok: true};
      case 'remove': {
        const i = records.findIndex((r) => r.id === msg.id);
        if (i >= 0 && !items.has(records[i].id)) records.splice(i, 1);
        saveHistorySoon();
        pushAll();
        return {ok: true};
      }
      case 'clear': {
        // Drops finished entries from the list; files stay on disk.
        for (let i = records.length - 1; i >= 0; i--) if (!items.has(records[i].id)) records.splice(i, 1);
        saveHistorySoon();
        pushAll();
        return {ok: true};
      }
      default:
        return {ok: false, error: 'unknown action'};
    }
  });
}
