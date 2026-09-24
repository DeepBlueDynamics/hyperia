// Search-stickys window (mode=search).
'use strict';

function start(ctx) {
  const {doc, ipc, persist} = ctx;
  const content = ctx.els.content;
  content.innerHTML = `
    <div class="search-container">
      <input type="text" id="searchInput" placeholder="search stickys" />
      <span class="search-refresh-btn" id="searchRefresh" title="Refresh sticky list">⟳</span>
    </div>
    <label class="search-opt"><input type="checkbox" id="optClear" checked> Clear previous search results</label>
    <label class="search-opt"><input type="checkbox" id="optReplace"> Replace existing stickys (vs. add to existing)</label>
    <div id="defaultView" class="default-view"></div>
    <div id="resultsList" class="results-list"></div>
  `;

  const searchInput = doc.getElementById('searchInput');
  const resultsList = doc.getElementById('resultsList');
  const defaultView = doc.getElementById('defaultView');
  const optClear = doc.getElementById('optClear');
  const optReplace = doc.getElementById('optReplace');
  let lastOpenedIds = [];
  let allNotes = persist
    .readNotes()
    .filter((n) => n.id !== 'sticky-search-window' && n.text && n.text.trim().length > 0);

  const recencyKey = (n) =>
    Date.parse(n.last_closed_at || '') || Date.parse(n.saved_at || '') || Date.parse(n.created_at || '') || 0;

  const shortStamp = (n) => {
    const t = recencyKey(n);
    if (!t) return '';
    const d = new Date(t);
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    const pad = (x) => String(x).padStart(2, '0');
    return `${mon} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  function makeResultItem(note) {
    const item = doc.createElement('div');
    item.className = 'result-item';
    item.style.backgroundColor = note.color && note.color.startsWith('#') ? note.color + '22' : 'rgba(0,0,0,0.03)';
    const header = doc.createElement('div');
    header.className = 'result-item-header';
    const title = doc.createElement('span');
    title.className = 'result-item-title';
    title.textContent = note.name || 'Untitled Note';
    header.appendChild(title);
    const stamp = doc.createElement('span');
    stamp.textContent = shortStamp(note);
    stamp.style.cssText = 'margin-left:auto;font-size:10px;opacity:0.55;white-space:nowrap;padding-right:6px;';
    header.appendChild(stamp);
    const colorDot = doc.createElement('span');
    colorDot.className = 'result-item-color';
    colorDot.style.backgroundColor = note.color && note.color.startsWith('#') ? note.color : '#fff9c4';
    header.appendChild(colorDot);
    item.appendChild(header);
    const body = doc.createElement('div');
    body.className = 'result-item-body';
    body.textContent = note.text ? note.text.replace(/\s+/g, ' ').substring(0, 100) : 'Empty note';
    item.appendChild(body);
    item.addEventListener('click', () => ipc.send('sticky-open-note', note.id));
    return item;
  }

  let currentMatchIds = [];

  function generateSummary() {
    ipc.send('generate-summary-sticky');
  }

  function openMatching(ids) {
    if (!ids.length) return;
    if (optReplace.checked) {
      ipc.send('open-matching-stickys', ids, true);
    } else {
      if (optClear.checked) {
        for (const id of lastOpenedIds) {
          if (!ids.includes(id)) ipc.send('sticky-close', id);
        }
      }
      ipc.send('open-matching-stickys', ids, false);
    }
    lastOpenedIds = ids.slice();
  }

  function renderDefault() {
    defaultView.style.display = '';
    resultsList.style.display = 'none';
    defaultView.innerHTML = '';
    const dd = doc.createElement('select');
    dd.className = 'action-dropdown';
    dd.innerHTML = '<option value="">⋯ Actions…</option><option value="summary">📋 Generate summary sticky</option>';
    dd.addEventListener('change', () => {
      if (dd.value === 'summary') generateSummary();
      dd.value = '';
    });
    defaultView.appendChild(dd);
    const heading = doc.createElement('div');
    heading.className = 'recent-heading';
    heading.textContent = 'Recently opened';
    defaultView.appendChild(heading);
    const recent = [...allNotes].sort((a, b) => recencyKey(b) - recencyKey(a)).slice(0, 10);
    if (recent.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'no-results';
      empty.textContent = 'No stickys yet';
      defaultView.appendChild(empty);
    } else {
      const rl = doc.createElement('div');
      rl.className = 'results-list';
      for (const note of recent) rl.appendChild(makeResultItem(note));
      defaultView.appendChild(rl);
    }
  }

  function renderResults(query) {
    if (!query.trim()) {
      currentMatchIds = [];
      renderDefault();
      return;
    }
    defaultView.style.display = 'none';
    resultsList.style.display = '';
    resultsList.innerHTML = '';
    const q = query.toLowerCase();
    const filtered = allNotes
      .filter((n) => (n.name && n.name.toLowerCase().includes(q)) || (n.text && n.text.toLowerCase().includes(q)))
      .sort((a, b) => recencyKey(b) - recencyKey(a));
    currentMatchIds = filtered.map((n) => n.id);
    if (filtered.length === 0) {
      resultsList.innerHTML = `<div class="no-results">No stickys found</div>`;
      return;
    }
    const ids = filtered.map((n) => n.id);
    const actions = doc.createElement('div');
    actions.className = 'results-actions';
    const count = doc.createElement('span');
    count.className = 'count';
    count.textContent = `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`;
    actions.appendChild(count);
    const openAllBtn = doc.createElement('span');
    openAllBtn.className = 'results-action-btn';
    openAllBtn.textContent = 'Open all ↵';
    openAllBtn.title = 'Open every match (honors the checkboxes above)';
    openAllBtn.addEventListener('click', () => openMatching(ids));
    actions.appendChild(openAllBtn);
    resultsList.appendChild(actions);
    for (const note of filtered) resultsList.appendChild(makeResultItem(note));
  }

  const refreshBtn = doc.getElementById('searchRefresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      allNotes = persist
        .readNotes()
        .filter((n) => n.id !== 'sticky-search-window' && n.text && n.text.trim().length > 0);
      renderResults(searchInput.value);
    });
  }
  ipc.on('stickys-changed', () => {
    allNotes = persist.readNotes().filter((n) => n.id !== 'sticky-search-window' && n.text && n.text.trim().length > 0);
    renderResults(searchInput.value);
  });
  searchInput.addEventListener('input', () => renderResults(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      ipc.send('sticky-close', 'sticky-search-window');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openMatching(currentMatchIds);
    }
  });
  searchInput.focus();
  renderDefault();
}

module.exports = {start};
