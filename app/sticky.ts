// Sticky note windows — frameless, always-on-top, colored floating notes.
// Loads static sticky.html from app dir. Persists to ~/.hyperia/stickys/notes.json.

import {readFileSync, writeFileSync, mkdirSync} from 'fs';
import {homedir} from 'os';
import {join, resolve} from 'path';

import {BrowserWindow, ipcMain, Menu, screen, app, nativeImage} from 'electron';

import isDev from 'electron-is-dev';

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

function generateNoteName(): string {
  const adj = NOTE_ADJECTIVES[Math.floor(Math.random() * NOTE_ADJECTIVES.length)];
  const animal = NOTE_ANIMALS[Math.floor(Math.random() * NOTE_ANIMALS.length)];
  const name = `${adj} ${animal}`;
  // 1/3 chance of an emoji prefix
  if (Math.random() < 1 / 3) {
    const emoji = NOTE_EMOJIS[Math.floor(Math.random() * NOTE_EMOJIS.length)];
    return `${emoji} ${name}`;
  }
  return name;
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
};

function readAllNotes(): NoteData[] {
  try {
    return JSON.parse(readFileSync(join(stickysDir(), 'notes.json'), 'utf8')) as NoteData[];
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
  return readAllNotes().find((n) => n.id === id);
}

function upsertNote(note: NoteData) {
  const notes = readAllNotes();
  const idx = notes.findIndex((n) => n.id === note.id);
  if (idx >= 0) notes[idx] = {...notes[idx], ...note};
  else notes.push(note);
  writeAllNotes(notes);
}

function deleteNote(id: string): boolean {
  const notes = readAllNotes();
  const next = notes.filter((note) => note.id !== id);
  if (next.length === notes.length) return false;
  writeAllNotes(next);
  return true;
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
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  // Slim default — compact sticky size
  const width = options.width || 280;
  const height = options.height || 220;

  const x =
    options.x ?? Math.round(display.workArea.x + display.workArea.width / 2 - width / 2 + Math.random() * 60 - 30);
  const y =
    options.y ?? Math.round(display.workArea.y + display.workArea.height / 2 - height / 2 + Math.random() * 60 - 30);

  // Determine or generate note ID
  const noteId = options.id || `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Already open? Focus it.
  const existing = stickyWindows.get(noteId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  // Generate a random name (or use existing)
  const savedNote = options.id ? getNote(options.id) : undefined;
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
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });

  // Persist initial record for notes
  if (!options.filePath) {
    const current = getNote(noteId) || {
      id: noteId,
      name: displayName,
      color: colorHex,
      text: options.text || '',
      x,
      y,
      width,
      height
    };
    upsertNote({...current, name: displayName, x, y, width, height, color: colorHex});
  }

  stickyWindows.set(noteId, win);

  // Build the URL with query params
  const htmlPath = resolve(isDev ? __dirname : app.getAppPath(), 'sticky.html');
  const queryParams = new URLSearchParams();
  queryParams.set('id', noteId);
  queryParams.set('color', colorHex);
  queryParams.set('name', displayName);
  if (options.filePath) queryParams.set('file', options.filePath);
  void win.loadFile(htmlPath, {search: queryParams.toString()});

  // Show and focus once ready
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    win.webContents.focus();

    // DevTools on the first sticky for diagnostics
    if (devToolsFirst) {
      devToolsFirst = false;
      win.webContents.openDevTools({mode: 'detach'});
    }
  });

  // Persist geometry on move/resize
  const saveGeom = () => {
    if (options.filePath) return; // file mode doesn't persist
    const bounds = win.getBounds();
    const note = getNote(noteId);
    if (note) {
      upsertNote({...note, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height});
    }
  };
  win.on('moved', saveGeom);
  win.on('resized', saveGeom);

  win.on('closed', () => {
    stickyWindows.delete(noteId);
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

  // Close from renderer
  ipcMain.on('sticky-close', (_event, noteId: string) => {
    const win = stickyWindows.get(noteId);
    if (win && !win.isDestroyed()) {
      // Mark as closed in metadata but keep the record
      const note = getNote(noteId);
      if (note) {
        upsertNote({...note, last_closed_at: new Date().toISOString()});
      }
      win.close();
    }
  });

  // Color change from renderer — update window backgroundColor
  ipcMain.on('sticky-color', (_event, noteId: string, color: string) => {
    const win = stickyWindows.get(noteId);
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(color);
    }
  });

  // Native context menu — can extend beyond window bounds
  ipcMain.on('sticky-context-menu', (event, noteId: string, hasSelection: boolean) => {
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

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Color',
        submenu: colors.map((c) => ({
          label: c.name,
          icon: makeColorSwatch(c.hex),
          click: () => {
            event.sender.send('sticky-set-color', c.hex);
          }
        }))
      },
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
      {
        label: 'Rename...',
        click: () => event.sender.send('sticky-rename')
      },
      {
        label: 'Delete',
        click: () => event.sender.send('sticky-delete')
      }
    ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup({window: win});
  });

  // Renderer reported geometry change (redundant with win events, keeps alive)
  ipcMain.on('sticky-geom', () => {
    // handled by win.on('moved'/'resized') above
  });

  // Restore notes that were open last time (skip ones explicitly closed)
  const notes = readAllNotes();
  for (const note of notes) {
    if (note.filePath) continue; // file mode notes aren't restored
    if (note.text && note.text.trim().length > 0) {
      // Only restore notes with content and not marked as closed recently
      const lastClosed = note.last_closed_at ? Date.parse(note.last_closed_at) : 0;
      const lastSaved = note.saved_at ? Date.parse(note.saved_at) : 0;
      // Skip notes closed AFTER their last save (user explicitly closed)
      if (lastClosed > lastSaved) continue;

      // Don't auto-restore on startup — too aggressive
      // Just keep the record so next time user creates a note with same ID it restores
    }
  }
}

export function closeStickyNote(noteId: string): boolean {
  const win = stickyWindows.get(noteId);
  if (win && !win.isDestroyed()) {
    const note = getNote(noteId);
    if (note) {
      upsertNote({...note, last_closed_at: new Date().toISOString()});
    }
    win.close();
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
  return deleted;
}

export {createStickyNote, readAllNotes};
