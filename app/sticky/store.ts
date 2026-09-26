import {readFileSync, renameSync, writeFileSync} from 'fs';
import {join} from 'path';

import {translateContainerPath} from './constants';
import {stickysDir} from './preferences';
import {fileWatchPaths, notifySearchWindowChanged, stickyWindows} from './registry';
import type {NoteData, StickyRun, StickyRunState} from './types';

export type NotesRead = {ok: true; notes: NoteData[]} | {ok: false; error: string};

function notesPath(): string {
  return join(stickysDir(), 'notes.json');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Strict read: a missing file is an empty list; a torn or corrupt file is an error, never []. */
export function readNotesStrict(attempts = 3): NotesRead {
  let error = '';
  for (let i = 0; i < attempts; i++) {
    let raw: string;
    try {
      raw = readFileSync(notesPath(), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {ok: true, notes: []};
      error = String(e);
      if (i < attempts - 1) sleepSync(40);
      continue;
    }
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new Error('notes.json is not an array');
      return {
        ok: true,
        notes: arr.filter((n) => n && typeof n === 'object' && typeof n.id === 'string') as NoteData[]
      };
    } catch (e) {
      // Another writer may be mid-write (the renderer and sidecar also write); retry briefly.
      error = String(e);
      if (i < attempts - 1) sleepSync(40);
    }
  }
  return {ok: false, error};
}

/** Lenient read for display paths only. Writers go through mutateNotes. */
export function readAllNotes(): NoteData[] {
  const r = readNotesStrict();
  return r.ok ? r.notes : [];
}

export function writeAllNotes(notes: NoteData[]): void {
  try {
    const dest = notesPath();
    const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
    // The legacy `schedule` field is dropped on write (runs replaced it).
    const clean = notes.map((n) => {
      if (!('schedule' in n)) return n;
      const rest = {...n};
      delete rest.schedule;
      return rest;
    });
    writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
    renameSync(tmp, dest);
  } catch (e) {
    console.error('Failed to write notes.json:', e);
  }
  notifySearchWindowChanged();
}

/** The single main-process writer: read strictly, apply fn, write atomically. Refuses on a bad read. */
export function mutateNotes(fn: (notes: NoteData[]) => boolean): boolean {
  const r = readNotesStrict();
  if (!r.ok) {
    console.error('[sticky] notes.json unreadable; refusing to write so no notes are lost:', r.error);
    return false;
  }
  if (!fn(r.notes)) return false;
  writeAllNotes(r.notes);
  return true;
}

/** Patch one note in place; returns the updated note, or undefined if missing or unwritable. */
export function patchNote(id: string, fn: (note: NoteData) => void): NoteData | undefined {
  let out: NoteData | undefined;
  const ok = mutateNotes((notes) => {
    const note = notes.find((n) => n.id === id);
    if (!note) return false;
    fn(note);
    out = note;
    return true;
  });
  return ok ? out : undefined;
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
  mutateNotes((notes) => {
    const idx = notes.findIndex((n) => n.id === note.id);
    // Run fields are engine-owned; a stale whole-note upsert must not roll them back.
    if (idx >= 0) {
      const cur = notes[idx];
      notes[idx] = {...cur, ...note, run: cur.run, run_state: cur.run_state, result: cur.result};
    } else notes.push(note);
    return true;
  });
}

export function deleteNote(id: string): boolean {
  let removed = false;
  mutateNotes((notes) => {
    const idx = notes.findIndex((note) => note.id === id);
    if (idx < 0) return false;
    notes.splice(idx, 1);
    removed = true;
    return true;
  });
  return removed;
}

export function updateNote(id: string, text: string): boolean {
  const note = patchNote(id, (n) => {
    n.text = text;
  });

  if (note?.source && note.source.kind === 'file' && note.source.path) {
    try {
      writeFileSync(translateContainerPath(note.source.path), text, 'utf8');
    } catch (e) {
      console.error('sticky: failed to write updated content to linked file', note.source.path, e);
    }
  }

  const watchPath = fileWatchPaths.get(id);
  if (watchPath) {
    try {
      writeFileSync(watchPath, text, 'utf8');
    } catch (e) {
      console.error('sticky: failed to write updated content to watch path', watchPath, e);
    }
  }

  // If the window is open, send it a message to refresh without focusing or revealing
  const win = stickyWindows.get(id);
  if (win && !win.isDestroyed()) {
    win.webContents.send('note-updated', {id, text});
  }

  return !!(note || (win && !win.isDestroyed()));
}

// ── Run fields (engine-owned) ──────────────────────────────────────────────

function sendToNote(id: string, channel: string, ...args: unknown[]): void {
  const win = stickyWindows.get(id);
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

/** Push a note's run state to its window (on every change, and on window create). */
export function sendRunState(id: string, note: NoteData | undefined = getNote(id)): void {
  if (!note) return;
  sendToNote(note.id, 'sticky-run-state', note.run_state || {}, note.run || null);
}

function applyState(note: NoteData, patch: Partial<StickyRunState>): void {
  const next: StickyRunState = {...(note.run_state || {})};
  for (const [k, v] of Object.entries(patch) as [keyof StickyRunState, unknown][]) {
    if (v === undefined) delete next[k];
    else (next as Record<string, unknown>)[k] = v;
  }
  note.run_state = next;
}

/** Merge into run_state (undefined values delete keys) and notify the window. */
export function setRunState(id: string, patch: Partial<StickyRunState>): NoteData | undefined {
  const note = patchNote(id, (n) => applyState(n, patch));
  if (note) sendRunState(id, note);
  return note;
}

/** Write run and run_state together, atomically; run=null disarms. */
export function writeRun(id: string, run: StickyRun | null, patch: Partial<StickyRunState>): NoteData | undefined {
  const note = patchNote(id, (n) => {
    n.run = run;
    applyState(n, patch);
  });
  if (note) sendRunState(id, note);
  return note;
}

/** Replace the RESULT area (never the prompt). */
export function setResult(id: string, result: string): boolean {
  const note = patchNote(id, (n) => {
    n.result = result;
  });
  if (note) sendToNote(id, 'sticky-result', result);
  return !!note;
}
