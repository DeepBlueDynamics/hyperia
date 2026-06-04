// Sticky note windows — frameless, always-on-top, colored floating notes.
// Loads static sticky.html from app dir. Persists to ~/.hyperia/stickys/notes.json.

import {exec} from 'child_process';
import {readFileSync, writeFileSync, mkdirSync, watchFile, unwatchFile, existsSync} from 'fs';
import {homedir} from 'os';
import {join, resolve, basename, dirname} from 'path';

import {BrowserWindow, ipcMain, Menu, screen, app, nativeImage, shell, dialog, Notification} from 'electron';

import isDev from 'electron-is-dev';

function translateContainerPath(filePath: string): string {
  if (process.platform !== 'win32') {
    return filePath;
  }
  if (!filePath) {
    return filePath;
  }

  let normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('file:///')) {
    normalized = normalized.slice(8);
  } else if (normalized.startsWith('file://')) {
    normalized = normalized.slice(7);
  }

  if (normalized.startsWith('workspace/')) {
    normalized = '/' + normalized;
  }

  if (normalized.startsWith('/workspace/')) {
    const parts = normalized.slice(11).split('/');
    const workspaceName = parts[0];
    const relativePath = parts.slice(1).join('\\');

    const currentDir = app ? app.getAppPath() : __dirname;
    let projectRoot = currentDir;

    for (let i = 0; i < 5; i++) {
      if (basename(projectRoot).toLowerCase() === workspaceName.toLowerCase()) {
        return join(projectRoot, relativePath);
      }
      const parent = dirname(projectRoot);
      if (parent === projectRoot) break;
      projectRoot = parent;
    }

    // Fallback using package.json detection
    projectRoot = currentDir;
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(projectRoot, 'package.json'))) {
        return join(projectRoot, relativePath);
      }
      const parent = dirname(projectRoot);
      if (parent === projectRoot) break;
      projectRoot = parent;
    }
  }

  return filePath;
}

const NOTE_ADJECTIVES = [
  'Bold',
  'Brave',
  'Calm',
  'Clever',
  'Cosmic',
  'Curious',
  'Dapper',
  'Dreamy',
  'Eager',
  'Elegant',
  'Fancy',
  'Fierce',
  'Fluffy',
  'Friendly',
  'Gentle',
  'Glowing',
  'Happy',
  'Honest',
  'Jolly',
  'Kind',
  'Lazy',
  'Lively',
  'Lucky',
  'Mighty',
  'Neat',
  'Noble',
  'Odd',
  'Proud',
  'Quick',
  'Quiet',
  'Relaxed',
  'Royal',
  'Silly',
  'Sleepy',
  'Sly',
  'Smug',
  'Snappy',
  'Spicy',
  'Spotless',
  'Sunny',
  'Swift',
  'Tame',
  'Tidy',
  'Tiny',
  'Wild',
  'Wise',
  'Witty',
  'Zesty',
  'Moody',
  'Furious',
  'Stormy',
  'Creative',
  'Thoughtful',
  'Patient',
  'Sparkly',
  'Drowsy'
];

const NOTE_ANIMALS = [
  'Badger',
  'Beaver',
  'Bison',
  'Capybara',
  'Cat',
  'Cheetah',
  'Crab',
  'Dolphin',
  'Elephant',
  'Falcon',
  'Ferret',
  'Fox',
  'Frog',
  'Giraffe',
  'Goose',
  'Heron',
  'Hippo',
  'Iguana',
  'Jaguar',
  'Kangaroo',
  'Koala',
  'Lemur',
  'Lion',
  'Llama',
  'Lynx',
  'Manatee',
  'Mole',
  'Moose',
  'Narwhal',
  'Newt',
  'Octopus',
  'Otter',
  'Owl',
  'Panda',
  'Panther',
  'Parrot',
  'Penguin',
  'Platypus',
  'Puma',
  'Quokka',
  'Rabbit',
  'Raccoon',
  'Raven',
  'Seal',
  'Shark',
  'Slug',
  'Sloth',
  'Snail',
  'Squirrel',
  'Stork',
  'Tapir',
  'Tiger',
  'Toucan',
  'Turtle',
  'Vicuna',
  'Walrus',
  'Weasel',
  'Whale',
  'Wolf',
  'Wombat',
  'Yak',
  'Zebra'
];

const NOTE_EMOJIS = [
  '📝',
  '📌',
  '📋',
  '🗒️',
  '✨',
  '💡',
  '🌟',
  '⭐',
  '🔖',
  '🎯',
  '🔮',
  '🧠',
  '💭',
  '🌙',
  '🪐',
  '🌸',
  '🍀',
  '🌿',
  '🔥',
  '⚡',
  '🦊',
  '🦉',
  '🐸',
  '🦋',
  '🐙',
  '🌊',
  '🍄',
  '🌻',
  '🕯️',
  '🎨'
];

// Strip a leading emoji/symbol prefix so "🐸 Jolly Turtle" and "Jolly Turtle"
// count as the SAME base name for uniqueness — the emoji is decorative, not
// part of the note's identity.
function noteNameBase(name: string): string {
  return (name || '')
    .replace(/^[^\sA-Za-z0-9]+\s*/, '')
    .trim()
    .toLowerCase();
}

// 56 adjectives × 62 animals = 3,472 base names. With dozens of notes the
// birthday-paradox makes plain random collide often (that's how two
// "Jolly Turtle" happened) — so reroll until the base name is unused.
function generateNoteName(): string {
  const taken = new Set(readAllNotes().map((n) => noteNameBase(n.name || '')));
  for (let attempt = 0; attempt < 300; attempt++) {
    const adj = NOTE_ADJECTIVES[Math.floor(Math.random() * NOTE_ADJECTIVES.length)];
    const animal = NOTE_ANIMALS[Math.floor(Math.random() * NOTE_ANIMALS.length)];
    const base = `${adj} ${animal}`;
    if (taken.has(base.toLowerCase())) continue; // collision → reroll
    if (Math.random() < 1 / 3) {
      const emoji = NOTE_EMOJIS[Math.floor(Math.random() * NOTE_EMOJIS.length)];
      return `${emoji} ${base}`;
    }
    return base;
  }
  // Exhausted (>3k notes) — guarantee uniqueness with a numeric suffix.
  const adj = NOTE_ADJECTIVES[Math.floor(Math.random() * NOTE_ADJECTIVES.length)];
  const animal = NOTE_ANIMALS[Math.floor(Math.random() * NOTE_ANIMALS.length)];
  return `${adj} ${animal} ${readAllNotes().length + 1}`;
}

type StickyColor = {bg: string; text: string; name: string};

const STICKY_COLORS: StickyColor[] = [
  {bg: '#fff9c4', text: '#333', name: 'yellow'},
  {bg: '#c8e6c9', text: '#1b5e20', name: 'green'},
  {bg: '#bbdefb', text: '#0d47a1', name: 'blue'},
  {bg: '#f8bbd0', text: '#880e4f', name: 'pink'},
  {bg: '#e1bee7', text: '#4a148c', name: 'purple'},
  {bg: '#ffe0b2', text: '#e65100', name: 'orange'}
];

let colorIndex = 0;
const stickyWindows = new Map<string, BrowserWindow>(); // noteId -> window
let devToolsFirst = false; // Set true to debug sticky windows

function nextColor(): StickyColor {
  const color = STICKY_COLORS[colorIndex % STICKY_COLORS.length];
  colorIndex++;
  return color;
}

/// Make a small BMP swatch for native menu icons.
function makeColorSwatch(hex: string) {
  // 16x16 BMP with solid color
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const size = 16;

  // BMP header (14 bytes) + DIB header (40 bytes) + pixel data
  const rowBytes = Math.ceil((24 * size) / 32) * 4;
  const pixelSize = rowBytes * size;
  const fileSize = 54 + pixelSize;
  const buf = Buffer.alloc(fileSize);

  // BMP header
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // data offset

  // DIB header
  buf.writeUInt32LE(40, 14); // header size
  buf.writeInt32LE(size, 18); // width
  buf.writeInt32LE(size, 22); // height
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(pixelSize, 34); // image size

  // Pixels (BGR, bottom-up)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = 54 + y * rowBytes + x * 3;
      buf[offset] = b;
      buf[offset + 1] = g;
      buf[offset + 2] = r;
    }
  }

  return nativeImage.createFromBuffer(buf);
}

function stickysDir(): string {
  const dir = join(homedir(), '.hyperia', 'stickys');
  try {
    mkdirSync(dir, {recursive: true});
  } catch {
    // exists
  }
  return dir;
}

function getStickyDefaultSize(): {width: number; height: number} {
  try {
    const d = JSON.parse(readFileSync(join(stickysDir(), 'defaults.json'), 'utf8'));
    return {width: d.width || 280, height: d.height || 220};
  } catch {
    return {width: 280, height: 220};
  }
}

function saveStickyDefaultSize(width: number, height: number) {
  // Merge — defaults.json also holds the renderer-owned fontSize/titleFontSize,
  // so overwriting with just {width,height} would wipe the user's font size.
  try {
    const p = join(stickysDir(), 'defaults.json');
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(readFileSync(p, 'utf8')) || {};
    } catch {
      d = {};
    }
    d.width = width;
    d.height = height;
    writeFileSync(p, JSON.stringify(d), 'utf8');
  } catch (e) {
    console.error('Failed to save sticky defaults:', e);
  }
}

// ── Global "see through" mode ───────────────────────────────────────────────
// ONE toggle for ALL stickys: either every sticky is semi-transparent or none
// is. No per-sticky focus/hover opacity. Persisted in defaults.json.
const STICKY_SEETHROUGH_OPACITY = 0.6;
let stickySeeThrough = false;

function loadStickySeeThrough(): boolean {
  try {
    return !!JSON.parse(readFileSync(join(stickysDir(), 'defaults.json'), 'utf8')).seeThrough;
  } catch {
    return false;
  }
}

function saveStickySeeThrough(on: boolean) {
  try {
    const p = join(stickysDir(), 'defaults.json');
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(readFileSync(p, 'utf8')) || {};
    } catch {
      d = {};
    }
    d.seeThrough = on;
    writeFileSync(p, JSON.stringify(d), 'utf8');
  } catch (e) {
    console.error('Failed to save sticky seeThrough:', e);
  }
}

function stickyOpacityNow(): number {
  return stickySeeThrough ? STICKY_SEETHROUGH_OPACITY : 1.0;
}

function applyStickySeeThrough() {
  const op = stickyOpacityNow();
  for (const [, win] of stickyWindows) {
    if (!win.isDestroyed()) win.setOpacity(op);
  }
}

function toggleStickySeeThrough() {
  stickySeeThrough = !stickySeeThrough;
  saveStickySeeThrough(stickySeeThrough);
  applyStickySeeThrough();
}

type StickySchedule = {
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

type NoteData = {
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
  schedule?: StickySchedule | null;
  // Bind a normal (editable) sticky to a file on disk. When set, the note's
  // body IS the file: loaded from disk on open, written back (debounced) on
  // edit. Distinct from `filePath` above, which is the read-only drag-in viewer.
  source?: {kind: 'file'; path: string} | null;
  // true while a window is open for this note. Set true when opened, false
  // ONLY on explicit close. An app quit (taskkill) leaves it true, so
  // "active" notes reopen on next launch.
  open?: boolean;
};

function readAllNotes(): NoteData[] {
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

function writeAllNotes(notes: NoteData[]) {
  try {
    writeFileSync(join(stickysDir(), 'notes.json'), JSON.stringify(notes, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write notes.json:', e);
  }
}

function getNote(id: string): NoteData | undefined {
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

function upsertNote(note: NoteData) {
  const notes = readAllNotes();
  const idx = notes.findIndex((n) => n.id === note.id);
  if (idx >= 0) notes[idx] = {...notes[idx], ...note};
  else notes.push(note);
  writeAllNotes(notes);
}

function updateNote(id: string, text: string): boolean {
  const notes = readAllNotes();
  const note = notes.find((n) => n.id === id);
  if (!note) return false;
  note.text = text;
  writeAllNotes(notes);
  // If the window is open, send it a message to refresh
  const win = stickyWindows.get(id);
  if (win && !win.isDestroyed()) {
    win.webContents.send('note-updated', {id, text});
  }
  // updateNote is the EXTERNAL path (agent / MCP sticky_note_update). If you're
  // not already looking at the note, ping you that it changed — clicking the
  // notification opens it. Skipped when the note window is focused (you can
  // see the live update) and rate-limited so a streaming agent isn't spammy.
  const focused = win && !win.isDestroyed() && win.isFocused();
  if (!focused) notifyStickyUpdated(note);
  return true;
}

const lastStickyNotify = new Map<string, number>();
function notifyStickyUpdated(note: NoteData): void {
  if (!Notification.isSupported()) return;
  const now = Date.now();
  const last = lastStickyNotify.get(note.id) || 0;
  if (now - last < 30000) return; // at most one ping per note per 30s
  lastStickyNotify.set(note.id, now);
  const n = new Notification({
    title: `📝 ${note.name || 'Sticky'} updated`,
    body: (note.text || '').replace(/\s+/g, ' ').slice(0, 140)
  });
  n.on('click', () => {
    const w = stickyWindows.get(note.id);
    if (w && !w.isDestroyed()) {
      w.show();
      w.focus();
    } else {
      createStickyNote({id: note.id});
    }
  });
  n.show();
}

function deleteNote(id: string): boolean {
  const notes = readAllNotes();
  const next = notes.filter((note) => note.id !== id);
  if (next.length === notes.length) return false;
  writeAllNotes(next);
  return true;
}

// ── File binding (Aegis-Edit v1: a sticky is a live view of a file on disk) ────
// v1 save semantics: the open sticky owns the file; edits debounced-write the
// whole file from the renderer. (v2 will diff + route through apply_text_edits
// for multi-agent / locked-block editing.)
function bindStickyFile(noteId: string, sender: Electron.WebContents): void {
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
  // Modal to the sticky window when we can resolve it, else a free dialog.
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
          console.error(`sticky: could not read ${filePath}:`, (e as Error).message);
          return;
        }
        const name = basename(filePath);
        upsertNote({id: noteId, source: {kind: 'file', path: filePath}, text: content, name});
        if (!sender.isDestroyed()) sender.send('sticky-bind-file', {path: filePath, content, name});
        startFileWatch(noteId, filePath); // live-refresh on external edits
      } catch (e) {
        console.error('sticky: link handler error:', e);
      }
    })
    .catch((e) => console.error('sticky: link dialog error:', e));
}

function unbindStickyFile(noteId: string, sender: Electron.WebContents): void {
  upsertNote({id: noteId, source: null});
  stopFileWatch(noteId);
  sender.send('sticky-unbind-file');
}

function bindOpenFile(noteId: string): void {
  const note = getNote(noteId);
  if (note?.source?.path) void shell.openPath(translateContainerPath(note.source.path));
}

// Watch a linked file so external edits (another editor, an agent via
// apply_text_edits) refresh the open sticky live. We POLL (watchFile) rather
// than fs.watch on purpose: apply_text_edits writes atomically (temp + rename),
// and fs.watch on Windows loses the file when it's replaced by a rename, so it
// never fires. Polling stat() on the path survives the swap. The renderer
// ignores a push whose content already matches its textarea, so the sticky's
// OWN writes don't echo back into a loop.
const fileWatchPaths = new Map<string, string>();
function startFileWatch(noteId: string, filePath: string): void {
  const translated = translateContainerPath(filePath);
  stopFileWatch(noteId);
  fileWatchPaths.set(noteId, translated);
  watchFile(translated, {interval: 600}, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return; // no real change
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
function stopFileWatch(noteId: string): void {
  const p = fileWatchPaths.get(noteId);
  if (p) {
    unwatchFile(p);
    fileWatchPaths.delete(noteId);
  }
}

function createStickyNote(
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
  } = {}
) {
  if (options.filePath) {
    options.filePath = translateContainerPath(options.filePath);
  }

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  // Determine or generate note ID
  const noteId = options.id || `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Already open? Bring it to front and focus.
  const existing = stickyWindows.get(noteId);
  if (existing && !existing.isDestroyed()) {
    if (!existing.isVisible()) {
      existing.show();
    }
    existing.setAlwaysOnTop(true, 'floating');
    existing.focus();
    return existing;
  }

  // Generate a random name (or use existing)
  const savedNote = options.id ? getNote(options.id) : undefined;
  if (savedNote?.source?.path) {
    savedNote.source.path = translateContainerPath(savedNote.source.path);
  }

  // Resolve default size (explicit > persisted manual size > default).
  const defaultSize = getStickyDefaultSize();
  let width = options.width || savedNote?.width || defaultSize.width;
  let height = options.height || savedNote?.height || defaultSize.height;

  // Candidate position: explicit > persisted > centered on the cursor.
  const hasPlacedPos = options.x != null || options.y != null || savedNote?.x != null || savedNote?.y != null;
  let x = options.x ?? savedNote?.x ?? Math.round(cursor.x - width / 2);
  let y = options.y ?? savedNote?.y ?? Math.round(cursor.y - height / 2);

  // Clamp size AND position to the work area of the monitor the note actually
  // lives on (multi-monitor: the display nearest the note's own position, not
  // the primary or the cursor's). Without this a tall persisted height — e.g. a
  // note saved at 1928px — restores past the bottom of a portrait monitor.
  const targetDisplay = hasPlacedPos ? screen.getDisplayNearestPoint({x, y}) : display;
  const wa = targetDisplay.workArea;
  width = Math.min(width, wa.width);
  height = Math.min(height, wa.height);
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));

  const displayName = options.name || savedNote?.name || generateNoteName();

  // Pick color (use saved if restoring, else cycle)
  const colorHex = options.color || savedNote?.color || nextColor().bg;

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 200,
    minHeight: 150,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    focusable: true,
    show: false,
    backgroundColor: colorHex,
    webPreferences: {
      // Sticky-note windows render LOCAL content only — never remote URLs.
      // They need to load file:// images and source files the user drags
      // into a note (code stickies render local source on disk). The trio
      // below is the standard Electron "trusted local renderer" stack:
      //   nodeIntegration:true  → access fs from the renderer for live file watches
      //   contextIsolation:false → share renderer globals (we never load untrusted JS here)
      //   webSecurity:false      → allow file:// resources from arbitrary disk paths
      // Risk model: a sticky note that loads remote content would be a
      // separate window class with these defaults inverted. We don't have
      // any such call site; ripgrep for `new BrowserWindow` to verify.
      // CodeQL js/disabling-electron-websecurity is acknowledged here.
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });

  // Persist initial record for notes. Mark open=true so this note reopens on
  // next launch if Hyperia is quit while it's showing.
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
      // Stamp creation time on genuinely-new notes (this fallback only runs when
      // getNote returned nothing). Existing notes keep their original created_at.
      created_at: new Date().toISOString()
    };
    upsertNote({...current, name: displayName, x, y, width, height, color: colorHex, open: true});
  }

  stickyWindows.set(noteId, win);

  // Build the URL with query params
  const htmlPath = resolve(isDev ? __dirname : app.getAppPath(), 'sticky.html');
  const queryParams = new URLSearchParams();
  queryParams.set('id', noteId);
  queryParams.set('color', colorHex);
  queryParams.set('name', displayName);
  if (options.filePath) queryParams.set('file', options.filePath);
  if (noteId === 'sticky-search-window') queryParams.set('mode', 'search');
  void win.loadFile(htmlPath, {search: queryParams.toString()});

  // Show and focus once ready
  win.once('ready-to-show', () => {
    win.show();
    win.setAlwaysOnTop(true, 'floating');
    win.focus();
    win.webContents.focus();

    // Linked note → watch its file so external edits refresh it live.
    if (savedNote?.source?.kind === 'file' && savedNote.source.path) {
      startFileWatch(noteId, savedNote.source.path);
    }

    // DevTools on the first sticky for diagnostics
    if (devToolsFirst) {
      devToolsFirst = false;
      win.webContents.openDevTools({mode: 'detach'});
    }
  });

  // Persist geometry on move/resize
  // Ignore geometry events fired during creation/show. On a scaled monitor the
  // OS emits spurious resize/move while it lays the window out, and persisting
  // those bounds made notes grow a little EVERY restart (a feedback loop). Arm
  // only after the window has settled; after that, real user drags persist.
  let geomReady = false;
  setTimeout(() => {
    geomReady = true;
  }, 1200);
  const saveGeom = () => {
    if (!geomReady) return;
    if (options.filePath || noteId === 'sticky-search-window') return; // file mode + search window don't persist
    const bounds = win.getBounds();
    const note = getNote(noteId);
    if (note) {
      upsertNote({...note, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height});
      saveStickyDefaultSize(bounds.width, bounds.height);
    }
  };
  win.on('moved', saveGeom);
  win.on('resized', saveGeom);

  // Opacity is GLOBAL: every sticky honors the single "See through" toggle, with
  // no per-sticky focus/hover behavior. Apply the current mode on creation.
  if (!win.isDestroyed()) win.setOpacity(stickyOpacityNow());
  win.on('focus', () => {
    // Raise above sibling stickys (they're all alwaysOnTop, so a click focuses
    // but doesn't reorder within that layer — moveTop brings the clicked one
    // to the front).
    if (!win.isDestroyed()) win.moveTop();
  });

  win.on('closed', () => {
    stickyWindows.delete(noteId);
    stopFileWatch(noteId);
  });

  return win;
}

export function initSticky() {
  ipcMain.on('new-sticky', (_event, options?: {filePath?: string; text?: string}) => {
    createStickyNote(options || {});
  });

  ipcMain.on('new-sticky-file', (_event, filePath: string) => {
    createStickyNote({filePath, width: 600, height: 500});
  });

  ipcMain.on('search-stickies', () => {
    createStickyNote({
      id: 'sticky-search-window',
      name: '🔍 Search Stickys',
      color: '#ffffff',
      width: 400,
      height: 500
    });
  });

  // Close from renderer
  ipcMain.on('sticky-close', (_event, noteId: string) => {
    const win = stickyWindows.get(noteId);
    if (win && !win.isDestroyed()) {
      // Mark as closed (and not-open) in metadata but keep the record.
      const note = getNote(noteId);
      if (note) {
        upsertNote({...note, last_closed_at: new Date().toISOString(), open: false});
      }
      win.close();
    }
  });

  // Hide/show — temporarily hide sticky WINDOWS without closing/archiving them
  // (the note stays "open", just off-screen; show-all brings them back). Distinct
  // from sticky-close, which archives the note to closed-notes.
  ipcMain.on('hide-all-stickys', () => hideAllStickys());
  ipcMain.on('show-all-stickys', () => showAllStickys());
  ipcMain.on('hide-sticky', (_event, noteId: string) => hideSticky(noteId));
  ipcMain.on('hide-other-stickys', (_event, noteId: string) => hideAllStickys(noteId));

  // Open every note in `ids`. replace=true closes all currently-open note
  // windows (archives them) first; replace=false adds the matches alongside
  // whatever is already open.
  ipcMain.on('open-matching-stickys', (_event, ids: string[], replace: boolean) => {
    if (replace) {
      for (const [id, win] of stickyWindows.entries()) {
        if (id === SEARCH_WIN_ID) continue;
        if (!win.isDestroyed()) {
          const note = getNote(id);
          if (note) upsertNote({...note, last_closed_at: new Date().toISOString()});
          win.close();
        }
      }
    }
    for (const id of Array.isArray(ids) ? ids : []) {
      if (id !== SEARCH_WIN_ID) createStickyNote({id});
    }
  });

  // Generate a "Stickys Summary" note. Built in the main process because only
  // here do we know which notes are currently OPEN (active) vs merely saved.
  ipcMain.on('generate-summary-sticky', () => {
    createStickyNote({text: buildStickysSummary()});
  });

  // Directory picker for the scheduling panel.
  ipcMain.handle('sticky-pick-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const res = await dialog.showOpenDialog(win as BrowserWindow, {properties: ['openDirectory']});
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });

  // Schedule / unschedule a sticky (from the GUI panel or MCP).
  ipcMain.on('sticky-schedule', (_event, noteId: string, sched: StickySchedule) => {
    scheduleSticky(noteId, sched);
  });
  ipcMain.on('sticky-unschedule', (_event, noteId: string) => {
    unscheduleSticky(noteId);
  });

  // Start the scheduler poll loop + re-arm any schedules persisted on disk.
  startScheduler();

  // Restore the global see-through mode, then keep it in sync as stickys open.
  stickySeeThrough = loadStickySeeThrough();

  // Toggle see-through for ALL stickys (right-click menu item + Ctrl+Shift+T).
  ipcMain.on('sticky-toggle-seethrough', () => {
    toggleStickySeeThrough();
  });

  // Color change from renderer — update window backgroundColor (hex only, not code:* tokens)
  ipcMain.on('sticky-color', (_event, noteId: string, color: string) => {
    const win = stickyWindows.get(noteId);
    if (win && !win.isDestroyed() && color.startsWith('#')) {
      win.setBackgroundColor(color);
    }
  });

  // Native context menu — can extend beyond window bounds
  ipcMain.on(
    'sticky-context-menu',
    (event, noteId: string, hasSelection: boolean, _currentColor: string, isFileBound?: boolean) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;

      const colors = [
        {name: 'Yellow', hex: '#fff9c4'},
        {name: 'Pink', hex: '#ffb6c1'},
        {name: 'Green', hex: '#c8e6c9'},
        {name: 'Blue', hex: '#bbdefb'},
        {name: 'Peach', hex: '#ffe0b2'},
        {name: 'Lavender', hex: '#e1bee7'},
        {name: 'Khaki', hex: '#f0e68c'},
        {name: 'Plum', hex: '#dda0dd'},
        {name: 'Tomato', hex: '#ff6347'},
        {name: 'Gold', hex: '#ffd700'},
        {name: 'Mint', hex: '#90ee90'},
        {name: 'Salmon', hex: '#ffa07a'}
      ];

      const codeThemes: Electron.MenuItemConstructorOptions[] = [
        {type: 'separator'},
        {
          label: 'Code Highlighting — Light',
          icon: makeColorSwatch('#f8f8f2'),
          click: () => event.sender.send('sticky-set-color', 'code:light')
        },
        {
          label: 'Code Highlighting — Dark',
          icon: makeColorSwatch('#1e1e2e'),
          click: () => event.sender.send('sticky-set-color', 'code:dark')
        }
      ];

      const template: Electron.MenuItemConstructorOptions[] = [
        {
          label: 'Color',
          submenu: [
            ...colors.map((c) => ({
              label: c.name,
              icon: makeColorSwatch(c.hex),
              click: () => {
                event.sender.send('sticky-set-color', c.hex);
              }
            })),
            ...codeThemes
          ]
        },
        // Highlight is offered on every note now — code/file notes highlight the
        // read-only <pre>, text notes use the live hljs backdrop behind the
        // textarea. (`currentColor` no longer gates it.)
        {
          label: 'Syntax Highlight',
          submenu: [
            {
              label: 'Auto (highlight.js)',
              click: () => event.sender.send('sticky-set-highlight', 'static')
            },
            {
              label: 'AI Highlight',
              click: () => event.sender.send('sticky-set-highlight', 'agent')
            },
            {
              label: 'Off',
              click: () => event.sender.send('sticky-set-highlight', 'off')
            }
          ]
        },
        {type: 'separator'},
        {
          label: 'See Through',
          type: 'checkbox',
          checked: stickySeeThrough,
          accelerator: 'CommandOrControl+Shift+T',
          // Label only — the real key handling lives in the sticky renderer, so
          // don't also register it here (would double-toggle).
          registerAccelerator: false,
          // Global toggle — flips transparency for EVERY sticky, not just this one.
          click: () => toggleStickySeeThrough()
        },
        {type: 'separator'},
        // File binding: a normal sticky can become a live view of a file on disk.
        // Edits write back (debounced). Distinct from the read-only drag-in viewer.
        ...(isFileBound
          ? ([
              {label: 'Open File in OS Editor', click: () => bindOpenFile(noteId)},
              {label: 'Unlink File', click: () => unbindStickyFile(noteId, event.sender)}
            ] as Electron.MenuItemConstructorOptions[])
          : ([
              {label: 'Link to File…', click: () => bindStickyFile(noteId, event.sender)}
            ] as Electron.MenuItemConstructorOptions[])),
        {type: 'separator'},
        {
          label: 'Cut',
          enabled: hasSelection,
          role: 'cut'
        },
        {
          label: 'Copy',
          enabled: hasSelection,
          role: 'copy'
        },
        {
          label: 'Paste',
          role: 'paste'
        },
        {
          label: 'Copy All',
          click: () => event.sender.send('sticky-copy-all')
        },
        {type: 'separator'},
        {label: 'New Sticky', click: () => createStickyNote({})},
        {
          label: 'Clone This Sticky',
          click: () => {
            const n = getNote(noteId);
            createStickyNote({
              text: n?.text,
              color: n?.color,
              width: n?.width,
              height: n?.height,
              name: n?.name ? `${n.name} (copy)` : undefined
            });
          }
        },
        {
          label: 'Search Stickys...',
          click: () => {
            createStickyNote({
              id: 'sticky-search-window',
              name: '🔍 Search Stickys',
              color: '#ffffff',
              width: 400,
              height: 500
            });
          }
        },
        {
          // A linked sticky's name IS its file's basename — renaming the sticky
          // would just diverge from the file, so it's disabled while linked.
          label: isFileBound ? 'Rename… (linked to file)' : 'Rename...',
          enabled: !isFileBound,
          click: () => event.sender.send('sticky-rename')
        },
        {type: 'separator'},
        {
          label: 'Hide This',
          click: () => {
            if (!win.isDestroyed()) win.hide();
          }
        },
        // Only offer "Hide Others" if there's another visible sticky to hide.
        ...(otherStickysVisible(noteId) ? [{label: 'Hide Other Stickys', click: () => hideAllStickys(noteId)}] : []),
        // "Active" = currently-open notes (not closed/archived). Only show "Hide"
        // when something is visible, "Show" when something is hidden.
        ...(anyStickyVisible() ? [{label: 'Hide Active Stickys', click: () => hideAllStickys()}] : []),
        ...(anyStickyHidden() ? [{label: 'Show Active Stickys', click: () => showAllStickys()}] : []),
        {type: 'separator'},
        {
          label: 'Delete',
          click: () => event.sender.send('sticky-delete')
        }
      ];

      const menu = Menu.buildFromTemplate(template);
      menu.popup({window: win});
    }
  );

  // Open source file in default OS editor
  ipcMain.on('sticky-open-file', (_event, filePath: string) => {
    void shell.openPath(translateContainerPath(filePath));
  });

  // Open URL in default OS browser
  ipcMain.on('sticky-open-external', (_event, url: string) => {
    void shell.openExternal(url);
  });

  // Open a URL in the main terminal window as a web pane
  ipcMain.on('sticky-open-web-pane', (_event, url: string) => {
    const stickyWinSet = new Set(stickyWindows.values());
    const target = BrowserWindow.getAllWindows().find(
      (w) => !stickyWinSet.has(w) && !w.isDestroyed() && (w as any).rpc
    );
    if (target)
      (target as unknown as {rpc: {emit: (ch: string, data: unknown) => void}}).rpc.emit('open web pane req', {url});
  });

  // Open a note by name or ID from a [From: name] link
  ipcMain.on('sticky-open-note', (_event, nameOrId: string) => {
    const notes = readAllNotes();
    const note = notes.find((n) => n.id === nameOrId) ?? notes.find((n) => n.name === nameOrId);
    if (note) createStickyNote({id: note.id});
  });

  // Renderer reported geometry change (redundant with win events, keeps alive)
  ipcMain.on('sticky-geom', () => {
    // handled by win.on('moved'/'resized') above
  });

  // Reopen the notes that were ACTIVE (open) when Hyperia last quit. The `open`
  // flag is set true when a window opens and false ONLY on explicit close, so
  // an app quit (taskkill) leaves active notes flagged open → they reopen here.
  // Deferred a tick so the windows mount after the app is ready.
  setTimeout(() => {
    for (const note of readAllNotes()) {
      if (note.id === SEARCH_WIN_ID || note.filePath) continue;
      if (note.open && !stickyWindows.has(note.id)) {
        createStickyNote({id: note.id});
      }
    }
  }, 400);
}

export function closeStickyNote(noteId: string): boolean {
  const win = stickyWindows.get(noteId);
  if (win && !win.isDestroyed()) {
    const note = getNote(noteId);
    if (note) {
      upsertNote({...note, last_closed_at: new Date().toISOString(), open: false});
    }
    win.close();
    return true;
  }
  return false;
}

// --- Hide/show sticky windows (off-screen, not closed/archived) ---
// The search-stickys utility window is excluded — it's a tool, not a note.
const SEARCH_WIN_ID = 'sticky-search-window';

function hideAllStickys(exceptId?: string): void {
  for (const [id, win] of stickyWindows.entries()) {
    if (id === SEARCH_WIN_ID) continue;
    if (exceptId && id === exceptId) continue;
    if (!win.isDestroyed() && win.isVisible()) win.hide();
  }
}

function showAllStickys(): void {
  for (const [id, win] of stickyWindows.entries()) {
    if (id === SEARCH_WIN_ID) continue;
    if (!win.isDestroyed() && !win.isVisible()) win.showInactive();
  }
}

function hideSticky(noteId: string): void {
  const win = stickyWindows.get(noteId);
  if (win && !win.isDestroyed()) win.hide();
}

/** True if at least one note window (not the search tool) is currently shown. */
export function anyStickyVisible(): boolean {
  for (const [id, win] of stickyWindows.entries()) {
    if (id === SEARCH_WIN_ID) continue;
    if (!win.isDestroyed() && win.isVisible()) return true;
  }
  return false;
}

/** True if at least one note window exists but is hidden. */
export function anyStickyHidden(): boolean {
  for (const [id, win] of stickyWindows.entries()) {
    if (id === SEARCH_WIN_ID) continue;
    if (!win.isDestroyed() && !win.isVisible()) return true;
  }
  return false;
}

// ── Scheduling engine ────────────────────────────────────────────────────────
// Schedules live on the note record (notes.json `schedule` field) so they
// survive restart. A single poll loop fires due one-shots and matching cron
// minutes. A scheduled note with a runner (anything but 'notify') is "hard":
// locked read-only until unscheduled.
const SIDECAR = 'http://localhost:9800';

function computeFireAt(s: StickySchedule): number | undefined {
  if (s.when === 'reminder') {
    const mult = s.unit === 'h' ? 3600000 : s.unit === 'd' ? 86400000 : 60000;
    return Date.now() + (s.delay || 0) * mult;
  }
  if (s.when === 'at' && s.at) {
    const t = Date.parse(s.at);
    return isNaN(t) ? undefined : t;
  }
  return undefined; // cron has no single fire_at
}

function lockNote(noteId: string, locked: boolean): void {
  const win = stickyWindows.get(noteId);
  if (win && !win.isDestroyed()) win.webContents.send('sticky-lock', locked);
}

export function scheduleSticky(noteId: string, sched: StickySchedule): void {
  const note = getNote(noteId);
  if (!note) return;
  const s: StickySchedule = {...sched};
  s.fire_at = computeFireAt(s);
  upsertNote({...note, schedule: s});
  // Runner != notify → "hard" sticky (lock content until unscheduled).
  lockNote(noteId, s.runner !== 'notify');
  startScheduler(); // ensure the loop is running (e.g. MCP before initSticky ran)
}

export function unscheduleSticky(noteId: string): void {
  const note = getNote(noteId);
  if (!note) return;
  upsertNote({...note, schedule: null});
  lockNote(noteId, false);
}

function cronMatches(expr: string, d: Date): boolean {
  // Minimal 5-field cron: min hour dom mon dow. Supports *, */n, and exact.
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

async function fireSchedule(note: NoteData): Promise<void> {
  const s = note.schedule;
  if (!s) return;
  const title = note.name || 'Sticky';
  const body = (note.text || '').slice(0, 140);
  // Always notify so there's a visible signal a schedule fired. Clicking the
  // notification opens/focuses the note (reopening it if it was closed).
  if (Notification.isSupported()) {
    const n = new Notification({title: `⏰ ${title}`, body: body || 'Scheduled sticky fired'});
    n.on('click', () => {
      const w = stickyWindows.get(note.id);
      if (w && !w.isDestroyed()) {
        w.show();
        w.focus();
      } else {
        createStickyNote({id: note.id});
      }
    });
    n.show();
  }
  // Bring the sticky up — reopen it if it was closed. So a reminder/notify
  // schedule always pops the note in front, not just an OS notification.
  const win = stickyWindows.get(note.id);
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  } else {
    createStickyNote({id: note.id});
  }
  const cmd = extractRunCommands(note.text || '');
  try {
    if (s.runner === 'shell') {
      // Run the note's ```run``` block(s) and APPEND the output back into the
      // note. The rest of the note content is preserved.
      runStickyAndAppend(note.id, s.dir);
    } else if (s.runner === 'n8shell') {
      const full = s.dir ? `cd "${s.dir}"; ${cmd}` : cmd;
      await fetch(`${SIDECAR}/api/pane/new`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({profile: 'n8', command: full})
      });
    } else if (s.runner === 'n8agent') {
      // Hand the note to the nemesis8 agent shell to act on.
      await fetch(`${SIDECAR}/api/notes/${note.id}/agent-run`, {method: 'POST'}).catch(() => {});
    }
  } catch (e) {
    console.error('[sticky] schedule runner failed:', e);
  }
}

// Extract the command(s) inside ```run … ``` fenced block(s). Falls back to the
// whole note text if there's no run block.
function extractRunCommands(text: string): string {
  const re = /```run\s*\n([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trim());
  return blocks.length ? blocks.join('\n') : text.trim();
}

// Run a sticky's ```run``` block in a shell and append the captured output to
// the note as a ```result``` block. The note content (incl. the run block) is
// preserved — output is added below it.
function runStickyAndAppend(noteId: string, dir?: string): void {
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

let schedulerStarted = false;
function startScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // Re-lock any "hard" notes whose windows are open at startup.
  for (const note of readAllNotes()) {
    if (note.schedule && note.schedule.runner !== 'notify') lockNote(note.id, true);
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
        // One-shot: clear the schedule + unlock after firing.
        upsertNote({...note, schedule: null});
        lockNote(note.id, false);
        void fireSchedule(note);
      }
    }
  }, 15000);
}

/** True if any visible note window other than `exceptId` exists. */
function otherStickysVisible(exceptId: string): boolean {
  for (const [id, win] of stickyWindows.entries()) {
    if (id === SEARCH_WIN_ID || id === exceptId) continue;
    if (!win.isDestroyed() && win.isVisible()) return true;
  }
  return false;
}

// Gnosis-style "Stickys Summary" text: a header box (generated time + active/
// saved counts), an ACTIVE list (currently-open windows) and a SAVED list
// (everything else, recent first, capped), each as [From: name] links. Built
// in main because only here is the open-window set known.
function buildStickysSummary(): string {
  const all = readAllNotes().filter((n) => n.text && n.text.trim().length > 0);
  const openIds = new Set([...stickyWindows.keys()].filter((id) => id !== SEARCH_WIN_ID));
  const recency = (n: NoteData) => Date.parse(n.last_closed_at || '') || Date.parse(n.saved_at || '') || 0;
  const active = all.filter((n) => openIds.has(n.id)).sort((a, b) => recency(b) - recency(a));
  const saved = all.filter((n) => !openIds.has(n.id)).sort((a, b) => recency(b) - recency(a));

  const now = new Date();
  const ts =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')} ${now.toTimeString().slice(0, 8)}`;
  const bar = '─'.repeat(38);
  const padRow = (s: string) => '│ ' + s + ' '.repeat(Math.max(0, bar.length - 1 - s.length)) + '│';
  const title = 'Stickys Summary';
  const tp = Math.floor((bar.length - title.length) / 2);
  const preview = (n: NoteData) => (n.text || '').replace(/\s+/g, ' ').slice(0, 80);

  const lines: string[] = [
    '┌' + bar + '┐',
    '│' + ' '.repeat(tp) + title + ' '.repeat(bar.length - tp - title.length) + '│',
    '├' + bar + '┤',
    padRow('Generated: ' + ts),
    padRow(`Active: ${active.length}   Saved: ${saved.length}`),
    '└' + bar + '┘',
    ''
  ];
  if (active.length) {
    lines.push(`🟢 ACTIVE STICKYS (${active.length}):`);
    for (const n of active) lines.push(`- [From: ${n.name || n.id}] — ${preview(n)}`);
    lines.push('');
  }
  if (saved.length) {
    lines.push(`💾 SAVED STICKYS (${saved.length}):`);
    for (const n of saved.slice(0, 20)) lines.push(`- [From: ${n.name || n.id}] — ${preview(n)}`);
    if (saved.length > 20) lines.push(`… and ${saved.length - 20} more saved stickys`);
    lines.push('');
  }
  lines.push('💡 Ctrl/Cmd+click a [From: name] link to open that sticky.');
  return lines.join('\n');
}

export function deleteStickyNote(noteId: string): boolean {
  const deleted = deleteNote(noteId);
  const win = stickyWindows.get(noteId);
  if (win && !win.isDestroyed()) {
    win.close();
  }
  return deleted;
}

export function updateStickyNote(noteId: string, text: string): boolean {
  return updateNote(noteId, text);
}

export {createStickyNote, readAllNotes};
