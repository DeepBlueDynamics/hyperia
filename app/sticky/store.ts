import {readFileSync, renameSync, writeFileSync} from 'fs';
import {join} from 'path';

import {translateContainerPath} from './constants';
import {stickysDir} from './preferences';
import {fileWatchPaths, notifySearchWindowChanged, stickyWindows} from './registry';
import type {NoteData} from './types';

export function readAllNotes(): NoteData[] {
  try {
    const arr = JSON.parse(readFileSync(join(stickysDir(), 'notes.json'), 'utf8'));
    if (Array.isArray(arr)) {
      return arr.filter((n) => n && typeof n === 'object' && typeof n.id === 'string') as NoteData[];
    }
    return [];
  } catch {
    return [];
  }
}

export function writeAllNotes(notes: NoteData[]): void {
  try {
    // Temp + rename so a crash mid-write can't truncate every note (the
    // sidecar reads this file concurrently; mirrors util.rs's atomic writer).
    const dest = join(stickysDir(), 'notes.json');
    const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(notes, null, 2), 'utf8');
    renameSync(tmp, dest);
  } catch (e) {
    console.error('Failed to write notes.json:', e);
  }
  // Every note mutation funnels through here — nudge the open Search Stickys
  // window (if any) to re-read + re-render, so created/edited/deleted notes
  // appear live instead of only on the manual ⟳ button.
  notifySearchWindowChanged();
}

export function getNote(id: string): NoteData | undefined {
  const notes = readAllNotes();
  // Exact id wins; otherwise accept the short suffix users quote (e.g. "6r7t"
  // for "note-<ts>-6r7t"), case-insensitively.
  const exact = notes.find((n) => n.id === id);
  if (exact) return exact;
  const idl = id.toLowerCase();
  const suffix = '-' + idl;
  return notes.find((n) => {
    const nid = n.id.toLowerCase();
    return nid === idl || nid.endsWith(suffix);
  });
}

export function upsertNote(note: NoteData): void {
  const notes = readAllNotes();
  const idx = notes.findIndex((n) => n.id === note.id);
  if (idx >= 0) notes[idx] = {...notes[idx], ...note};
  else notes.push(note);
  writeAllNotes(notes);
}

export function deleteNote(id: string): boolean {
  const notes = readAllNotes();
  const next = notes.filter((note) => note.id !== id);
  if (next.length === notes.length) return false;
  writeAllNotes(next);
  return true;
}

export function updateNote(id: string, text: string): boolean {
  const notes = readAllNotes();
  const note = notes.find((n) => n.id === id);

  if (note) {
    note.text = text;
    writeAllNotes(notes);

    if (note.source && note.source.kind === 'file' && note.source.path) {
      try {
        const translated = translateContainerPath(note.source.path);
        writeFileSync(translated, text, 'utf8');
      } catch (e) {
        console.error(`sticky: failed to write updated content to linked file ${note.source.path}:`, e);
      }
    }
  }

  const watchPath = fileWatchPaths.get(id);
  if (watchPath) {
    try {
      writeFileSync(watchPath, text, 'utf8');
    } catch (e) {
      console.error(`sticky: failed to write updated content to watch path ${watchPath}:`, e);
    }
  }

  // If the window is open, send it a message to refresh without focusing or revealing
  const win = stickyWindows.get(id);
  if (win && !win.isDestroyed()) {
    win.webContents.send('note-updated', {id, text});
  }

  return !!(note || (win && !win.isDestroyed()));
}
