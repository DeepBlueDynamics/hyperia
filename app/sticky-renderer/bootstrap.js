// Sticky renderer entry. Loaded via require() from sticky.html (nodeIntegration).
// Explicit module graph — no hidden globals, no webpack entry.
'use strict';

const persistMod = require('./persist');
const theme = require('./theme');
const links = require('./links');
const syntaxMod = require('./syntax');
const fileBindMod = require('./file-bind');
const scheduleUi = require('./schedule-ui');
const runViewMod = require('./run-view');
const chrome = require('./chrome');
const searchMode = require('./search-mode');
const codeMode = require('./code-mode');
const noteMode = require('./note-mode');
const channels = require('./ipc-channels');
const fit = require('./fit');

function resolveMode(params, filePath) {
  if (params.get('mode') === 'search') return 'search';
  if (filePath) return 'code';
  return 'note';
}

// In-note confirm styled like the schedule panel; resolves true on Delete/Enter, false otherwise.
// Falls back to the native box if the overlay markup is missing.
function styledConfirm(doc, msg) {
  const overlay = doc.getElementById('confirmOverlay');
  if (!overlay) return doc.defaultView.confirm(msg);
  doc.getElementById('confirmTitle').textContent = msg;
  overlay.style.display = 'flex';
  return new Promise((resolve) => {
    const ok = doc.getElementById('confirmOk');
    const buttons = [ok, doc.getElementById('confirmCancel'), doc.getElementById('confirmClose')];
    const done = (result) => {
      overlay.style.display = 'none';
      buttons.forEach((b) => b && b.removeEventListener('click', b._confirmHandler));
      overlay.removeEventListener('mousedown', onBackdrop);
      doc.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onBackdrop = (e) => {
      if (e.target === overlay) done(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        done(e.key === 'Enter');
      }
    };
    buttons.forEach((b) => {
      if (!b) return;
      b._confirmHandler = () => done(b === ok);
      b.addEventListener('click', b._confirmHandler);
    });
    overlay.addEventListener('mousedown', onBackdrop);
    doc.addEventListener('keydown', onKey, true);
  });
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
    confirm: opts.confirm || ((msg) => styledConfirm(doc, msg)),
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
  // Run state comes from the saved note first; sticky-run-state pushes update it.
  ctx.runView = runViewMod.createRunView(ctx);
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
  doc.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const textarea = doc.getElementById('noteText');
    const hasSelection = textarea && textarea.selectionStart !== textarea.selectionEnd;
    const tok = textarea ? links.linkTokenAt(textarea.value, textarea.selectionStart) : null;
    const link = tok && tok.kind === 'url' ? tok.value : null;
    ipc.send('sticky-context-menu', noteId, hasSelection, ctx.state.bgColor, !!ctx.state.boundFilePath, link);
  });
  ipc.on('sticky-delete', () => {
    // confirm may be sync (tests) or a Promise (the styled overlay).
    Promise.resolve(ctx.confirm('Delete this note?')).then((ok) => {
      if (!ok) return;
      persist.writeNotes(persist.readNotes().filter((n) => n.id !== noteId));
      ipc.send('sticky-close', noteId);
    });
  });
  ipc.on('note-updated', (_e, payload) => {
    // A payload without text (e.g. a result-only update) must not blank the prompt.
    if (!payload || typeof payload.text !== 'string') return;
    const text = payload.text;
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
  const fitCaps = mode === 'search' ? null : fit.parseFitParam(params.get('fit'));
  if (fitCaps) void fit.start(ctx, fitCaps);
  return {ok: true, mode, ctx};
}

module.exports = {boot, resolveMode, channels};
