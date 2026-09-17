import type {BrowserWindow} from 'electron';

export type StickyWin = BrowserWindow & {__startedHidden?: boolean};

export type StickyColor = {
  bg: string;
  text: string;
  name: string;
};

export type StickySchedule = {
  when: 'reminder' | 'at' | 'cron';
  runner: 'notify' | 'shell' | 'n8shell' | 'n8agent';
  delay?: number; // reminder: count
  unit?: 'm' | 'h' | 'd'; // reminder unit
  at?: string; // 'at': datetime-local string
  cron?: string;
  dir?: string;
  created_at?: string;
  fire_at?: number; // computed epoch ms for one-shot schedules
  last_run?: string;
};

export type NoteData = {
  id: string;
  name?: string;
  text?: string;
  color?: string;
  filePath?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  saved_at?: string;
  last_closed_at?: string;
  created_at?: string;
  creator?: string;
  schedule?: StickySchedule | null;
  // Bind a normal (editable) sticky to a file on disk. When set, the note's
  // body IS the file: loaded from disk on open, written back (debounced) on
  // edit. Distinct from `filePath` above, which is the read-only drag-in viewer.
  source?: {kind: 'file'; path: string} | null;
  // true while a window is open for this note. Set true when opened, false
  // ONLY on explicit close. An app quit (taskkill) leaves it true, so
  // "active" notes reopen on next launch.
  open?: boolean;
  [key: string]: unknown; // preserve any unknown fields across shared writers
};

export type StickyRef = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  open: boolean;
};
