// Sticky renderer entry. Loaded via require() from sticky.html (nodeIntegration).
// Explicit module graph — no hidden globals, no webpack entry.
'use strict';

const persistMod = require('./persist');
const theme = require('./theme');
const links = require('./links');
const syntaxMod = require('./syntax');
const fileBindMod = require('./file-bind');
const scheduleUi = require('./schedule-ui');
const chrome = require('./chrome');
const searchMode = require('./search-mode');
const codeMode = require('./code-mode');
const noteMode = require('./note-mode');
const channels = require('./ipc-channels');

function resolveMode(params, filePath) {
  if (params.get('mode') === 'search') return 'search';
  if (filePath) return 'code';
  return 'note';
}

function boot(opts) {
  opts = opts || {};
  const electron = opts.electron || require('electron');
  const ipc = opts.ipc || electron.ipcRenderer;
  const clipboard = opts.clipboard || electron.clipboard;
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  const win = opts.window || (typeof window !== 'undefined' ? window : null);
  if (!doc || !win) {
    return {ok: false, reason: 'no-dom'};
  }

  const persist = persistMod.createPersist(opts.persistDeps);
  const params = new URLSearchParams(win.location.search);
  const noteId = params.get('id') || '';
  const filePath = persist.translateContainerPath(params.get('file') || '');
  const nameParam = params.get('name') || '';
  const isSearchMode = params.get('mode') === 'search';
  const saved = noteId ? persist.findNote(noteId) : null;
  const bgColor = (saved && saved.color) || params.get('color') || '#fff9c4';
  const displayName = (saved && saved.name) || nameParam || noteId;

  const ctx = {
    persist,
    ipc,
    clipboard,
    doc,
    win,
    confirm: opts.confirm || ((msg) => win.confirm(msg)),
    els: {
      titleText: doc.getElementById('titleText'),
      titleInput: doc.getElementById('titleInput'),
      content: doc.getElementById('content'),
      closeBtn: doc.getElementById('closeBtn'),
      linesBtn: doc.getElementById('linesBtn')
    },
    state: {
      noteId,
      filePath,
      isSearchMode,
      displayName,
      bgColor,
      saved,
      highlightMode: 'static',
      syntaxOn: false,
      boundFilePath: null,
      stickyFontSize: 22
    },
    channels
  };

  theme.start(ctx);
  theme.applyBgColor(doc, bgColor);
  if (ctx.els.titleText) ctx.els.titleText.textContent = displayName;

  const syntax = syntaxMod.createSyntax(ctx);
  ctx.syntax = syntax;
  syntax.start();
  if (saved && saved.syntax) {
    ctx.state.highlightMode = 'static';
    syntax.setSyntax(true);
  }

  const fileBind = fileBindMod.createFileBind(ctx);
  ctx.fileBind = fileBind;
  fileBind.start();
  links.start(ctx);
  scheduleUi.start(ctx);
  // Title copy/rename before mode dispatch — original sticky.html ~1516.
  chrome.start(ctx);

  if (ctx.els.closeBtn) {
    ctx.els.closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ipc.send('sticky-close', noteId);
    });
  }

  ipc.on('sticky-set-color', (_e, color) => {
    ctx.state.bgColor = color;
    theme.applyBgColor(doc, color);
    const note = persist.findNote(noteId) || {id: noteId, name: ctx.state.displayName};
    note.color = color;
    note.saved_at = new Date().toISOString();
    persist.saveNote(note);
    ipc.send('sticky-color', noteId, color);
  });
  ipc.on('sticky-copy-all', () => {
    const el = doc.getElementById('noteText');
    if (el) clipboard.writeText(el.value);
  });
  ipc.on('sticky-lock', (_e, locked) => {
    const ta = doc.getElementById('noteText');
    if (ta) ta.readOnly = !!locked;
    doc.body.classList.toggle('sched-armed', !!locked);
  });
  ipc.on('sticky-armed', (_e, armed) => {
    const btn = doc.getElementById('scheduleBtn');
    if (btn) btn.classList.toggle('armed', !!armed);
  });
  doc.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const textarea = doc.getElementById('noteText');
    const hasSelection = textarea && textarea.selectionStart !== textarea.selectionEnd;
    const tok = textarea ? links.linkTokenAt(textarea.value, textarea.selectionStart) : null;
    const link = tok && tok.kind === 'url' ? tok.value : null;
    ipc.send('sticky-context-menu', noteId, hasSelection, ctx.state.bgColor, !!ctx.state.boundFilePath, link);
  });
  ipc.on('sticky-delete', () => {
    if (!ctx.confirm('Delete this note?')) return;
    persist.writeNotes(persist.readNotes().filter((n) => n.id !== noteId));
    ipc.send('sticky-close', noteId);
  });
  ipc.on('note-updated', (_e, payload) => {
    const text = payload && typeof payload.text === 'string' ? payload.text : '';
    const ta = doc.getElementById('noteText');
    if (ta) {
      if (ta.value !== text) ta.value = text;
      return;
    }
    const block = doc.getElementById('codeBlock');
    const codeEl = block && block.querySelector('code');
    if (codeEl) {
      if (codeEl.dataset.raw === text) return;
      codeEl.dataset.raw = text;
      syntax.applyHighlight(text, codeEl);
      if (ctx.state.highlightMode !== 'agent') syntax.wrapCodeLines(codeEl);
    }
  });

  const mode = resolveMode(params, filePath);
  if (mode === 'search') searchMode.start(ctx);
  else if (mode === 'code') codeMode.start(ctx);
  else noteMode.start(ctx);
  return {ok: true, mode, ctx};
}

module.exports = {boot, resolveMode, channels};
