// Sticky note windows — frameless, always-on-top, colored floating notes.
// Can be plain text or file viewer with syntax highlighting.

import {readFileSync} from 'fs';
import {basename, extname} from 'path';

import {BrowserWindow, ipcMain, screen} from 'electron';

const STICKY_COLORS = [
  {bg: '#fff9c4', text: '#333', name: 'yellow'},
  {bg: '#c8e6c9', text: '#1b5e20', name: 'green'},
  {bg: '#bbdefb', text: '#0d47a1', name: 'blue'},
  {bg: '#f8bbd0', text: '#880e4f', name: 'pink'},
  {bg: '#e1bee7', text: '#4a148c', name: 'purple'},
  {bg: '#ffe0b2', text: '#e65100', name: 'orange'}
];

let colorIndex = 0;
const stickyWindows = new Map<number, {filePath?: string; color: (typeof STICKY_COLORS)[0]}>();

function nextColor() {
  const color = STICKY_COLORS[colorIndex % STICKY_COLORS.length];
  colorIndex++;
  return color;
}

function createStickyNote(
  options: {
    filePath?: string;
    content?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } = {}
) {
  const color = nextColor();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  const width = options.width || 320;
  const height = options.height || 280;
  const x = options.x ?? display.workArea.x + display.workArea.width / 2 - width / 2 + Math.random() * 60 - 30;
  const y = options.y ?? display.workArea.y + display.workArea.height / 2 - height / 2 + Math.random() * 60 - 30;

  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(x),
    y: Math.round(y),
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: color.bg,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  stickyWindows.set(win.id, {filePath: options.filePath, color});

  // Build the sticky note HTML
  const filePath = options.filePath;
  let fileContent = options.content || '';
  let fileName = '';
  let fileExt = '';

  if (filePath) {
    try {
      fileContent = readFileSync(filePath, 'utf8');
      fileName = basename(filePath);
      fileExt = extname(filePath).slice(1).toLowerCase();
    } catch (e) {
      fileContent = `Error reading file: ${(e as Error).message}`;
    }
  }

  const isFileMode = !!filePath;
  const escapedContent = fileContent
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const html = buildStickyHtml({
    bgColor: color.bg,
    textColor: color.text,
    content: isFileMode ? escapedContent : '',
    rawContent: isFileMode ? '' : fileContent,
    fileName,
    fileExt,
    isFileMode,
    winId: win.id
  });

  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  win.on('closed', () => {
    stickyWindows.delete(win.id);
  });

  return win;
}

function buildStickyHtml(opts: {
  bgColor: string;
  textColor: string;
  content: string;
  rawContent: string;
  fileName: string;
  fileExt: string;
  isFileMode: boolean;
  winId: number;
}): string {
  const langClass = opts.fileExt ? `language-${mapExtToLang(opts.fileExt)}` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${opts.fileName || 'Sticky Note'}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><${'/'}>script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body {
    background: ${opts.bgColor};
    color: ${opts.textColor};
    font-family: -apple-system, 'Segoe UI', sans-serif;
    font-size: 13px;
    display: flex;
    flex-direction: column;
  }
  .titlebar {
    height: 24px;
    display: flex;
    align-items: center;
    padding: 0 6px;
    -webkit-app-region: drag;
    flex-shrink: 0;
    opacity: 0.6;
    font-size: 10px;
    user-select: none;
  }
  .titlebar:hover { opacity: 1; }
  .titlebar-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .titlebar-btn {
    width: 16px; height: 16px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 50%;
    cursor: pointer;
    -webkit-app-region: no-drag;
    font-size: 10px;
    opacity: 0.5;
    transition: opacity 0.2s;
  }
  .titlebar-btn:hover { opacity: 1; }
  .close-btn:hover { background: rgba(255,0,0,0.2); }
  .lines-btn:hover { background: rgba(0,0,0,0.1); }
  .stealth-btn:hover { background: rgba(0,0,0,0.1); }

  .content {
    flex: 1;
    overflow: auto;
    padding: 8px 10px;
  }

  /* Plain text mode */
  .note-text {
    width: 100%;
    height: 100%;
    border: none;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 13px;
    resize: none;
    outline: none;
    line-height: 1.5;
  }

  /* File mode */
  pre {
    margin: 0;
    font-family: 'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace;
    font-size: 12px;
    line-height: 1.6;
    tab-size: 4;
    background: transparent !important;
    color: inherit;
  }
  code { background: transparent !important; }

  /* Line numbers */
  .with-lines {
    counter-reset: line;
  }
  .with-lines .line {
    display: block;
    counter-increment: line;
  }
  .with-lines .line::before {
    content: counter(line);
    display: inline-block;
    width: 3em;
    margin-right: 1em;
    text-align: right;
    color: ${opts.textColor};
    opacity: 0.3;
    font-size: 10px;
    user-select: none;
  }

  /* Stealth: hide line numbers */
  .stealth .line::before { display: none; }

  /* Resize handle */
  .resize-handle {
    position: absolute;
    bottom: 0; right: 0;
    width: 14px; height: 14px;
    cursor: nwse-resize;
    opacity: 0.3;
  }
  .resize-handle:hover { opacity: 0.6; }
</style>
</head>
<body>
  <div class="titlebar">
    <span class="titlebar-text">${opts.fileName || ''}</span>
    ${opts.isFileMode ? '<span class="titlebar-btn lines-btn" onclick="toggleLines()" title="Toggle line numbers">#</span>' : ''}
    ${opts.isFileMode ? '<span class="titlebar-btn stealth-btn" onclick="toggleStealth()" title="Stealth mode">S</span>' : ''}
    <span class="titlebar-btn close-btn" onclick="window.close()" title="Close">&times;</span>
  </div>
  <div class="content" id="content">
    ${
      opts.isFileMode
        ? `<pre id="codeBlock" class="with-lines"><code class="${langClass}">${opts.content}</code></pre>`
        : `<textarea class="note-text" placeholder="Type a note..." autofocus>${opts.rawContent}</textarea>`
    }
  </div>
  <svg class="resize-handle" viewBox="0 0 14 14">
    <path d="M12 2v10H2" fill="none" stroke="${opts.textColor}" stroke-width="1" opacity="0.3"/>
    <path d="M12 6v6H6" fill="none" stroke="${opts.textColor}" stroke-width="1" opacity="0.3"/>
    <path d="M12 10v2h-2" fill="none" stroke="${opts.textColor}" stroke-width="1" opacity="0.3"/>
  </svg>
  <script>
    ${
      opts.isFileMode
        ? `
      // Highlight code
      hljs.highlightAll();

      // Wrap lines for line numbering
      const codeEl = document.querySelector('code');
      if (codeEl) {
        const lines = codeEl.innerHTML.split('\\n');
        codeEl.innerHTML = lines.map(l => '<span class="line">' + l + '</span>').join('\\n');
      }

      function toggleLines() {
        document.getElementById('codeBlock').classList.toggle('with-lines');
      }
      function toggleStealth() {
        document.getElementById('codeBlock').classList.toggle('stealth');
      }
    `
        : `
      // Auto-save note content (debounced)
      const textarea = document.querySelector('.note-text');
      let saveTimer;
      textarea.addEventListener('input', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          // TODO: persist to sticky store
        }, 1000);
      });
    `
    }
  </script>
</body>
</html>`;
}

function mapExtToLang(ext: string): string {
  const map: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sql: 'sql',
    md: 'markdown',
    dockerfile: 'dockerfile',
    r: 'r',
    lua: 'lua',
    swift: 'swift',
    kt: 'kotlin',
    ex: 'elixir',
    exs: 'elixir',
    erl: 'erlang',
    hs: 'haskell',
    ml: 'ocaml',
    nix: 'nix'
  };
  return map[ext] || ext;
}

export function initSticky() {
  ipcMain.on('new-sticky', (_event, options?: {filePath?: string; content?: string}) => {
    createStickyNote(options || {});
  });

  ipcMain.on('new-sticky-file', (_event, filePath: string) => {
    createStickyNote({filePath, width: 600, height: 500});
  });
}

export {createStickyNote};
