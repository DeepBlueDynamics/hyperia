import {readFileSync, unwatchFile, watchFile} from 'fs';
import {basename} from 'path';

import {BrowserWindow, dialog, shell} from 'electron';

import {translateContainerPath} from './constants';
import {fileWatchPaths, stickyWindows} from './registry';
import {getNote, upsertNote} from './store';

export function bindStickyFile(noteId: string, sender: Electron.WebContents): void {
  const win = BrowserWindow.fromWebContents(sender);
  const opts: Electron.OpenDialogOptions = {
    title: 'Link sticky to file',
    properties: ['openFile'],
    filters: [
      {
        name: 'Text & code',
        extensions: [
          'txt',
          'md',
          'markdown',
          'rs',
          'ts',
          'tsx',
          'js',
          'jsx',
          'json',
          'py',
          'sh',
          'toml',
          'yaml',
          'yml',
          'html',
          'css'
        ]
      },
      {name: 'All files', extensions: ['*']}
    ]
  };
  const dlg = win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
  dlg
    .then((res) => {
      try {
        if (res.canceled || !res.filePaths.length) return;
        const filePath = res.filePaths[0];
        let content = '';
        try {
          content = readFileSync(filePath, 'utf8');
        } catch (e) {
          console.error('sticky: could not read', filePath, (e as Error).message);
          return;
        }
        const name = basename(filePath);
        upsertNote({id: noteId, source: {kind: 'file', path: filePath}, text: content, name});
        if (!sender.isDestroyed()) sender.send('sticky-bind-file', {path: filePath, content, name});
        startFileWatch(noteId, filePath);
      } catch (e) {
        console.error('sticky: link handler error:', e);
      }
    })
    .catch((e) => console.error('sticky: link dialog error:', e));
}

export function unbindStickyFile(noteId: string, sender: Electron.WebContents): void {
  upsertNote({id: noteId, source: null});
  stopFileWatch(noteId);
  sender.send('sticky-unbind-file');
}

export function bindOpenFile(noteId: string): void {
  const note = getNote(noteId);
  if (note?.source?.path) void shell.openPath(translateContainerPath(note.source.path));
}

export function startFileWatch(noteId: string, filePath: string): void {
  const translated = translateContainerPath(filePath);
  stopFileWatch(noteId);
  fileWatchPaths.set(noteId, translated);
  watchFile(translated, {interval: 600}, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    const win = stickyWindows.get(noteId);
    if (!win || win.isDestroyed()) return;
    try {
      const content = readFileSync(translated, 'utf8');
      win.webContents.send('sticky-file-changed', {content});
    } catch {
      /* file removed mid-edit; ignore this tick */
    }
  });
}

export function stopFileWatch(noteId: string): void {
  const p = fileWatchPaths.get(noteId);
  if (p) {
    unwatchFile(p);
    fileWatchPaths.delete(noteId);
  }
}
