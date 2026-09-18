// Editable text-note mode: textarea, links, find, save.
// Title click/copy/rename live in chrome.js (before mode dispatch).
'use strict';

const links = require('./links');
const find = require('./find');

function start(ctx) {
  const {doc, ipc, persist, syntax, fileBind, clipboard, win} = ctx;
  const titleInput = ctx.els.titleInput;
  const content = ctx.els.content;
  const saved = ctx.state.saved;

  const findWrap = doc.createElement('div');
  findWrap.className = 'note-find-wrap';
  const highlightBackdrop = doc.createElement('div');
  highlightBackdrop.className = 'find-highlights';
  highlightBackdrop.id = 'findHighlights';
  const textarea = doc.createElement('textarea');
  textarea.className = 'note-text';
  textarea.id = 'noteText';
  textarea.placeholder = '';
  textarea.value = (saved && saved.text) || '';
  textarea.spellcheck = false;

  if (saved && saved.source && saved.source.kind === 'file' && saved.source.path) {
    const translated = persist.translateContainerPath(saved.source.path);
    try {
      textarea.value = persist.fs.readFileSync(translated, 'utf8');
    } catch (e) {
      /* keep cached saved.text */
    }
    fileBind.setFileBound(translated);
  }

  const tickRail = doc.createElement('div');
  tickRail.className = 'find-tickrail';
  tickRail.id = 'findTickrail';
  findWrap.appendChild(highlightBackdrop);
  findWrap.appendChild(textarea);
  findWrap.appendChild(tickRail);
  content.appendChild(findWrap);

  textarea.addEventListener('scroll', () => {
    highlightBackdrop.scrollTop = textarea.scrollTop;
    highlightBackdrop.scrollLeft = textarea.scrollLeft;
  });
  textarea.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (links.followLinkInTextarea(textarea, ipc)) e.preventDefault();
      return;
    }
    const tok = links.linkTokenAt(textarea.value, textarea.selectionStart);
    if (tok && tok.kind === 'url') {
      clipboard.writeText(tok.value);
      links.showToast(doc, 'Link copied · right-click for options');
      e.preventDefault();
    }
  });

  const escBackdrop = (s) => s.replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c]);
  let ctrlLinksShown = false;
  function showCtrlLinks() {
    const fb = doc.getElementById('findBar');
    if (fb && fb.style.display !== 'none') return;
    if (ctx.state.syntaxOn) return;
    const text = textarea.value;
    const ranges = links.allLinkRanges(text);
    if (!ranges.length) {
      highlightBackdrop.innerHTML = '';
      return;
    }
    let html = '';
    let pos = 0;
    for (const [s, e] of ranges) {
      if (s < pos) continue;
      html += escBackdrop(text.slice(pos, s));
      html += '<span class="ctrl-link">' + escBackdrop(text.slice(s, e)) + '</span>';
      pos = e;
    }
    html += escBackdrop(text.slice(pos)) + '\n';
    highlightBackdrop.innerHTML = html;
    highlightBackdrop.scrollTop = textarea.scrollTop;
    highlightBackdrop.scrollLeft = textarea.scrollLeft;
  }
  function hideCtrlLinks() {
    const fb = doc.getElementById('findBar');
    if (fb && fb.style.display !== 'none') return;
    syntax.restoreBackdrop();
  }
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !ctrlLinksShown) {
      ctrlLinksShown = true;
      textarea.style.cursor = 'pointer';
      showCtrlLinks();
    }
  });
  const clearCtrl = () => {
    if (!ctrlLinksShown) return;
    ctrlLinksShown = false;
    textarea.style.cursor = '';
    hideCtrlLinks();
  };
  textarea.addEventListener('keyup', (e) => {
    if (!e.ctrlKey && !e.metaKey) clearCtrl();
  });
  textarea.addEventListener('blur', clearCtrl);

  const forceFocus = (setCursorAtEnd = false) => {
    const findBar = doc.getElementById('findBar');
    if (findBar && findBar.style.display !== 'none') {
      const findInput = doc.getElementById('findInput');
      if (findInput && doc.activeElement !== findInput) findInput.focus();
      return;
    }
    if (titleInput && titleInput.style.display !== 'none') {
      if (doc.activeElement !== titleInput) titleInput.focus();
      return;
    }
    const schedOverlay = doc.getElementById('schedOverlay');
    if (schedOverlay && schedOverlay.style.display !== 'none') return;
    if (doc.activeElement !== textarea) {
      textarea.focus();
      if (setCursorAtEnd) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  };
  forceFocus(true);
  setTimeout(() => forceFocus(true), 50);
  setTimeout(() => forceFocus(true), 200);
  setTimeout(() => forceFocus(true), 500);
  content.addEventListener('click', (e) => {
    if (e.target !== textarea) forceFocus(false);
  });
  doc.body.addEventListener('click', (e) => {
    if (e.target === doc.body) forceFocus(false);
  });
  win.addEventListener('focus', () => forceFocus(false));

  let saveTimer;
  textarea.addEventListener('input', () => {
    syntax.scheduleSyntax();
    fileBind.scheduleBoundFileSave();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!ctx.state.noteId) return;
      const existing = persist.findNote(ctx.state.noteId) || {
        id: ctx.state.noteId,
        name: ctx.state.displayName,
        color: ctx.state.bgColor
      };
      existing.text = textarea.value;
      existing.color = ctx.state.bgColor;
      existing.name = ctx.state.displayName;
      existing.saved_at = new Date().toISOString();
      persist.saveNote(existing);
    }, 500);
  });
  ipc.on('note-updated', () => {
    if (ctx.state.syntaxOn) syntax.scheduleSyntax();
  });

  find.start(ctx);
}

module.exports = {start};
