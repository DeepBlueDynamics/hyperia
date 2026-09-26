import type {BrowserWindow} from 'electron';

export type StickyWin = BrowserWindow & {__startedHidden?: boolean};

export type StickyColor = {
  bg: string;
  text: string;
  name: string;
};

export type RunEvery =
  | {kind: 'interval'; minutes: number} // >= 1
  | {kind: 'daily'; time: string} // "HH:MM", local time
  | {kind: 'weekly'; days: number[]; time: string} // 0=Sun..6=Sat
  | {kind: 'cron'; expr: string}; // 5-field, validated

export type StickyRunAgent = {provider: string; model?: string; image: 'default'; dir: string; danger: boolean};

export type StickyRun = {
  when: 'now' | 'at' | 'every';
  at?: string; // ISO 8601, required for 'at'
  every?: RunEvery; // required for 'every'
  target: 'notify' | 'agent' | 'pane';
  agent?: StickyRunAgent;
  pane?: {uid: string; name: string};
  history?: {keep: boolean; limit: number}; // limit = runs kept (default 50)
  paused?: boolean;
  created_by?: string; // "human" | "agent:<name>" | "pane:<uid>"
  approved?: {at: number}; // set once a human approves (agent-created runs, and every pane target)
};

export type RunStatus = 'ok' | 'failed' | 'halted' | 'skipped' | 'running' | 'awaiting_approval';

export type StickyRunState = {
  next_run?: number; // epoch ms
  last_run?: number;
  last_status?: RunStatus;
  last_error?: string;
  trigger_id?: string; // n8 trigger for the in-flight agent run
  run_id?: string; // in-flight run id
};

/** One line of ~/.hyperia/stickys/runs.jsonl. */
export type RunRecord = {
  note: string;
  run_id: string;
  started: number;
  finished: number;
  status: RunStatus;
  error?: string;
  target: StickyRun['target'];
  agent?: StickyRunAgent;
  pane?: {uid: string; name: string};
  result?: string;
};

export type NoteData = {
  id: string;
  name?: string;
  text?: string; // the PROMPT; never written by runs
  result?: string; // written only by the engine or an agent via sticky_note_update {result}
  run?: StickyRun | null;
  run_state?: StickyRunState;
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
