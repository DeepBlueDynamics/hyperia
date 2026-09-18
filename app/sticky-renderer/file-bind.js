// File-bound notes: body IS the file, debounced write-through.
'use strict';

function createFileBind(ctx) {
  const {doc, ipc, persist} = ctx;
  let fileSaveTimer = null;

  function setFileBound(p) {
    ctx.state.boundFilePath = p || null;
    const btn = doc.getElementById('fileBtn');
    if (btn) {
      btn.style.display = ctx.state.boundFilePath ? '' : 'none';
      btn.title = ctx.state.boundFilePath ? 'Linked to ' + ctx.state.boundFilePath + ' — click to open it' : '';
    }
    doc.body.classList.toggle('file-bound', !!ctx.state.boundFilePath);
  }
  function clearFileBound() {
    setFileBound(null);
  }
  function saveBoundFileNow() {
    if (!ctx.state.boundFilePath) return;
    const ta = doc.getElementById('noteText');
    if (!ta) return;
    try {
      persist.fs.writeFileSync(ctx.state.boundFilePath, ta.value, 'utf8');
    } catch (e) {
      console.error('sticky: file save failed:', e && e.message);
    }
  }
  function scheduleBoundFileSave() {
    if (!ctx.state.boundFilePath) return;
    clearTimeout(fileSaveTimer);
    fileSaveTimer = setTimeout(saveBoundFileNow, 500);
  }

  function start() {
    ipc.on('sticky-bind-file', (_e, info) => {
      try {
        const ta = doc.getElementById('noteText');
        if (ta && info && typeof info.content === 'string') {
          ta.value = info.content;
          if (ctx.syntax) ctx.syntax.scheduleSyntax();
        }
        if (info && info.name && ctx.els && ctx.els.titleText) {
          ctx.state.displayName = info.name;
          ctx.els.titleText.textContent = ctx.state.displayName;
        }
        setFileBound(info && info.path);
      } catch (err) {
        console.error('sticky: link apply failed:', err);
      }
    });
    ipc.on('sticky-unbind-file', () => {
      clearFileBound();
    });
    ipc.on('sticky-file-changed', (_e, info) => {
      try {
        if (!info || typeof info.content !== 'string') return;
        const ta = doc.getElementById('noteText');
        if (ta) {
          if (ta.value === info.content) return;
          const pos = ta.selectionStart;
          ta.value = info.content;
          try {
            ta.setSelectionRange(Math.min(pos, ta.value.length), Math.min(pos, ta.value.length));
          } catch (e) {
            /* ignore */
          }
          if (ctx.syntax) ctx.syntax.scheduleSyntax();
        } else {
          const block = doc.getElementById('codeBlock');
          const codeEl = block && block.querySelector('code');
          if (codeEl) {
            if (codeEl.dataset.raw === info.content) return;
            codeEl.dataset.raw = info.content;
            ctx.syntax.applyHighlight(info.content, codeEl);
            if (ctx.state.highlightMode !== 'agent') ctx.syntax.wrapCodeLines(codeEl);
          }
        }
      } catch (err) {
        console.error('sticky: file-changed apply failed:', err);
      }
    });
    const fb = doc.getElementById('fileBtn');
    if (fb) {
      fb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ctx.state.boundFilePath) ipc.send('sticky-open-file', ctx.state.boundFilePath);
      });
    }
  }

  return {setFileBound, clearFileBound, saveBoundFileNow, scheduleBoundFileSave, start};
}

module.exports = {createFileBind};
