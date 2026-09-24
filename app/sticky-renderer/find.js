// Ctrl+F find-in-note. Activates only when #noteText exists.
'use strict';

function start(ctx) {
  const {doc, win} = ctx;
  const findBar = doc.getElementById('findBar');
  const findInput = doc.getElementById('findInput');
  const findCount = doc.getElementById('findCount');
  if (!findBar || !findInput) return;
  let findMatches = [];
  let findIndex = -1;

  function getNoteTextarea() {
    return doc.getElementById('noteText');
  }
  function escapeFindHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c]);
  }
  function renderFindHighlights() {
    const ta = getNoteTextarea();
    const bd = doc.getElementById('findHighlights');
    if (!ta || !bd) return;
    if (!findMatches.length || !findInput.value) {
      bd.innerHTML = '';
      return;
    }
    const text = ta.value;
    const qlen = findInput.value.length;
    let html = '';
    let pos = 0;
    findMatches.forEach((matchAt, idx) => {
      html += escapeFindHtml(text.slice(pos, matchAt));
      const cls = idx === findIndex ? ' class="current"' : '';
      html += `<mark${cls}>` + escapeFindHtml(text.slice(matchAt, matchAt + qlen)) + '</mark>';
      pos = matchAt + qlen;
    });
    html += escapeFindHtml(text.slice(pos)) + '\n';
    bd.innerHTML = html;
    bd.scrollTop = ta.scrollTop;
    bd.scrollLeft = ta.scrollLeft;
  }
  function renderFindTicks() {
    const ta = getNoteTextarea();
    const bd = doc.getElementById('findHighlights');
    const rail = doc.getElementById('findTickrail');
    if (!ta || !bd || !rail) return;
    rail.innerHTML = '';
    if (!findMatches.length) return;
    if (ta.scrollHeight <= ta.clientHeight + 1) return;
    const railH = ta.clientHeight;
    const fullH = bd.scrollHeight || ta.scrollHeight;
    const marks = bd.querySelectorAll('mark');
    marks.forEach((m, idx) => {
      const tick = doc.createElement('div');
      tick.className = 'find-tick' + (idx === findIndex ? ' current' : '');
      tick.style.top = `${(m.offsetTop / fullH) * railH}px`;
      rail.appendChild(tick);
    });
  }
  function updateFindCount() {
    findCount.textContent = findMatches.length ? `${findIndex + 1}/${findMatches.length}` : '0/0';
  }
  function scrollToCurrentMatch() {
    const ta = getNoteTextarea();
    if (!ta || findIndex < 0) return;
    const matchAt = findMatches[findIndex];
    const linesBefore = ta.value.substring(0, matchAt).split('\n').length;
    const lineHeight = parseFloat(win.getComputedStyle(ta).lineHeight) || 22;
    ta.scrollTop = Math.max(0, linesBefore * lineHeight - ta.clientHeight / 2);
  }
  function refreshFind() {
    updateFindCount();
    renderFindHighlights();
    renderFindTicks();
  }
  function findCompute() {
    const ta = getNoteTextarea();
    findMatches = [];
    findIndex = -1;
    const q = findInput.value;
    if (ta && q) {
      const hay = ta.value.toLowerCase();
      const needle = q.toLowerCase();
      let i = hay.indexOf(needle);
      while (i !== -1) {
        findMatches.push(i);
        i = hay.indexOf(needle, i + 1);
      }
      if (findMatches.length) findIndex = 0;
    }
    if (findIndex >= 0) scrollToCurrentMatch();
    refreshFind();
  }
  function findNext() {
    if (!findMatches.length) return;
    findIndex = (findIndex + 1) % findMatches.length;
    scrollToCurrentMatch();
    refreshFind();
  }
  function findPrev() {
    if (!findMatches.length) return;
    findIndex = (findIndex - 1 + findMatches.length) % findMatches.length;
    scrollToCurrentMatch();
    refreshFind();
  }
  function openFind() {
    const ta = getNoteTextarea();
    if (!ta) return;
    if (ctx.state.syntaxOn) ta.style.color = '';
    findBar.style.display = '';
    findInput.value = '';
    findMatches = [];
    findIndex = -1;
    refreshFind();
    findInput.focus();
  }
  function closeFind() {
    findBar.style.display = 'none';
    findMatches = [];
    findIndex = -1;
    const rail = doc.getElementById('findTickrail');
    if (rail) rail.innerHTML = '';
    const ta = getNoteTextarea();
    if (ctx.state.syntaxOn && ta) ta.style.color = 'transparent';
    if (ctx.syntax) ctx.syntax.restoreBackdrop();
    else {
      const bd = doc.getElementById('findHighlights');
      if (bd) bd.innerHTML = '';
    }
    if (ta) ta.focus();
  }

  findInput.addEventListener('input', findCompute);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) findPrev();
      else findNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  });
  doc.getElementById('findPrev').addEventListener('click', findPrev);
  doc.getElementById('findNext').addEventListener('click', findNext);
  doc.getElementById('findClose').addEventListener('click', closeFind);

  const searchBtn = doc.getElementById('searchBtn');
  if (searchBtn) {
    if (ctx.state.isSearchMode || ctx.state.filePath) {
      searchBtn.style.display = 'none';
    } else {
      searchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (findBar.style.display === 'none') openFind();
        else closeFind();
      });
    }
  }
  doc.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
      if (ctx.state.isSearchMode) return;
      e.preventDefault();
      openFind();
    }
  });
}

module.exports = {start};
