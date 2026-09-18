import {exec} from 'child_process';

import {Notification} from 'electron';

import {SYSTEM_TOKEN} from '../system-token';

import {stickyWindows} from './registry';
import {getNote, readAllNotes, updateNote, upsertNote} from './store';
import type {NoteData, StickySchedule} from './types';

const SIDECAR = 'http://localhost:9800';

let stickyNoteOpener: ((options: {id?: string; focus?: boolean}) => void) | null = null;

export function setSchedulerNoteOpener(opener: (options: {id?: string; focus?: boolean}) => void): void {
  stickyNoteOpener = opener;
}

export function computeFireAt(s: StickySchedule): number | undefined {
  if ((s.when as string) === 'once') {
    return Date.now();
  }
  if (s.when === 'reminder') {
    const mult = s.unit === 'h' ? 3600000 : s.unit === 'd' ? 86400000 : 60000;
    return Date.now() + (s.delay || 0) * mult;
  }
  if (s.when === 'at' && s.at) {
    const t = Date.parse(s.at);
    return isNaN(t) ? undefined : t;
  }
  return undefined;
}

export function lockNote(noteId: string, locked: boolean): void {
  const win = stickyWindows.get(noteId);
  if (win && !win.isDestroyed()) win.webContents.send('sticky-lock', locked);
}

export function armNote(noteId: string, armed: boolean): void {
  const win = stickyWindows.get(noteId);
  if (win && !win.isDestroyed()) win.webContents.send('sticky-armed', armed);
}

export function scheduleSticky(noteId: string, sched: StickySchedule): void {
  const note = getNote(noteId);
  if (!note) return;
  const s: StickySchedule = {...sched};
  s.fire_at = computeFireAt(s);
  upsertNote({...note, schedule: s});
  lockNote(noteId, s.runner !== 'notify');
  armNote(noteId, true);
  startScheduler();
}

export function unscheduleSticky(noteId: string): void {
  const note = getNote(noteId);
  if (!note) return;
  upsertNote({...note, schedule: null});
  lockNote(noteId, false);
  armNote(noteId, false);
}

export function cronMatches(expr: string, d: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fields = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  return parts.every((p, i) => {
    const v = fields[i];
    if (p === '*') return true;
    const step = p.match(/^\*\/(\d+)$/);
    if (step) return v % Number(step[1]) === 0;
    return p.split(',').some((n) => Number(n) === v);
  });
}

export function extractRunCommands(text: string): string {
  const re = /```run\s*\n([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trim());
  return blocks.length ? blocks.join('\n') : text.trim();
}

export function runStickyAndAppend(noteId: string, dir?: string): void {
  const note = getNote(noteId);
  if (!note) return;
  const command = extractRunCommands(note.text || '');
  if (!command.trim()) return;
  const shellBin = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
  exec(
    command,
    {cwd: dir || undefined, shell: shellBin, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024},
    (err, stdout, stderr) => {
      let out = `${stdout || ''}${stderr || ''}`.trim();
      if (!out && err) out = String(err.message || err);
      const stamp = new Date().toLocaleString();
      const fresh = getNote(noteId);
      const base = (fresh ? fresh.text : note.text) || '';
      const appended = `${base}\n\n\`\`\`result ${stamp}\n${out.slice(0, 6000)}\n\`\`\``;
      updateNote(noteId, appended);
    }
  );
}

export async function fireSchedule(note: NoteData): Promise<void> {
  const s = note.schedule;
  if (!s) return;
  const title = note.name || 'Sticky';
  const body = (note.text || '').slice(0, 140);

  if (Notification.isSupported()) {
    const n = new Notification({title: `⏰ ${title}`, body: body || 'Scheduled sticky fired'});
    n.on('click', () => {
      // Stale notification click check: if note was deleted, do not resurrect!
      const fresh = getNote(note.id);
      if (!fresh) return;
      if (stickyNoteOpener) {
        stickyNoteOpener({id: note.id, focus: true});
      }
    });
    n.show();
  }

  const cmd = extractRunCommands(note.text || '');
  try {
    if (s.runner === 'shell') {
      const full = s.dir ? `cd "${s.dir}"; ${cmd}` : cmd;
      try {
        await fetch(`${SIDECAR}/api/pane/new`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${SYSTEM_TOKEN}`
          },
          body: JSON.stringify({command: full})
        });
      } catch {
        runStickyAndAppend(note.id, s.dir);
      }
    } else if (s.runner === 'n8shell') {
      const full = s.dir ? `cd "${s.dir}"; ${cmd}` : cmd;
      await fetch(`${SIDECAR}/api/pane/new`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYSTEM_TOKEN}`
        },
        body: JSON.stringify({profile: 'n8', command: full})
      });
    } else if (s.runner === 'n8agent') {
      await fetch(`${SIDECAR}/api/notes/${note.id}/agent-run`, {method: 'POST'}).catch(() => {});
    }
  } catch (e) {
    console.error('[sticky] schedule runner failed:', e);
  }
}

let schedulerStarted = false;

export function startScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  for (const note of readAllNotes()) {
    if (note.schedule) {
      armNote(note.id, true);
      if (note.schedule.runner !== 'notify') lockNote(note.id, true);
    }
  }

  let lastCronMinute = -1;
  setInterval(() => {
    const now = new Date();
    const nowMs = now.getTime();
    const minute = Math.floor(nowMs / 60000);
    const cronTick = minute !== lastCronMinute;
    if (cronTick) lastCronMinute = minute;
    for (const note of readAllNotes()) {
      const s = note.schedule;
      if (!s) continue;
      if (s.when === 'cron') {
        if (cronTick && s.cron && cronMatches(s.cron, now)) {
          upsertNote({...note, schedule: {...s, last_run: now.toISOString()}});
          void fireSchedule(note);
        }
      } else if (s.fire_at && nowMs >= s.fire_at) {
        upsertNote({...note, schedule: null});
        lockNote(note.id, false);
        armNote(note.id, false);
        void fireSchedule(note);
      }
    }
  }, 15000);
}
