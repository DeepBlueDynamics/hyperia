// Titlebar chrome shared by note/search/code. Original sticky.html registered
// title click/copy, dblclick-rename, and sticky-rename BEFORE mode dispatch.
'use strict';

function titleCopyText(state) {
  if (state.boundFilePath) return state.boundFilePath;
  const shortId = (state.noteId || '').split('-').pop() || '';
  return shortId ? `${state.displayName} (sticky ${shortId})` : state.displayName;
}

function startRename(ctx) {
  if (ctx.state.isSearchMode || ctx.state.filePath) return false;
  const titleText = ctx.els.titleText;
  const titleInput = ctx.els.titleInput;
  if (!titleText || !titleInput) return false;
  titleText.style.display = 'none';
  titleInput.style.display = '';
  titleInput.value = ctx.state.displayName;
  titleInput.focus();
  titleInput.select();
  return true;
}

function start(ctx) {
  const {doc, ipc, persist, clipboard} = ctx;
  const titleText = ctx.els.titleText;
  const titleInput = ctx.els.titleInput;
  const timers = ctx.timers || {setTimeout, clearTimeout};

  const titlebar = doc.querySelector('.titlebar');
  if (titlebar) {
    titlebar.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function commitRename() {
    if (!titleInput || !titleText) return;
    const newName = titleInput.value.trim();
    titleInput.style.display = 'none';
    titleText.style.display = '';
    if (newName && newName !== ctx.state.displayName) {
      ctx.state.displayName = newName;
      titleText.textContent = ctx.state.displayName;
      const note = persist.findNote(ctx.state.noteId) || {id: ctx.state.noteId, color: ctx.state.bgColor};
      note.name = ctx.state.displayName;
      note.saved_at = new Date().toISOString();
      persist.saveNote(note);
    }
  }
  function cancelRename() {
    if (!titleInput || !titleText) return;
    titleInput.style.display = 'none';
    titleText.style.display = '';
  }

  if (titleInput) {
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitRename();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelRename();
      }
    });
    titleInput.addEventListener('blur', () => commitRename());
  }

  let titleClickTimer = null;
  if (titleText) {
    titleText.addEventListener('click', (e) => {
      e.stopPropagation();
      if (titleClickTimer) return;
      titleClickTimer = timers.setTimeout(() => {
        titleClickTimer = null;
        const text = titleCopyText(ctx.state);
        clipboard.writeText(text);
        const orig = titleText.textContent;
        titleText.textContent = 'Copied ✓';
        timers.setTimeout(() => {
          titleText.textContent = orig;
        }, 700);
      }, 230);
    });
    titleText.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (titleClickTimer) {
        timers.clearTimeout(titleClickTimer);
        titleClickTimer = null;
      }
      if (ctx.state.boundFilePath) return;
      startRename(ctx);
    });
  }

  // Single sticky-rename registration (was duplicated in bootstrap + note-mode).
  ipc.on('sticky-rename', () => startRename(ctx));
}

module.exports = {start, startRename, titleCopyText};
