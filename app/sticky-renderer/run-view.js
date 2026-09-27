// Result (rendered Markdown), footer, armed/lock state and the history overlay.
// The run model starts from the saved note so armed state shows before any push.
'use strict';

const fmt = require('./run-format');
const links = require('./links');
const {defaultTimers} = require('./timers');
const {renderMarkdown} = require('./markdown');

function createRunView(ctx) {
  const {doc, ipc} = ctx;
  const timers = ctx.timers || defaultTimers();
  const now = ctx.now || (() => Date.now());
  const saved = ctx.state.saved || {};
  const model = {
    run: saved.run || null,
    state: saved.run_state || {},
    result: typeof saved.result === 'string' ? saved.result : '',
    historyCount: null
  };
  let textarea = null;
  let resultEl = null;
  let footerEl = null;
  let lockHint = null;
  let lastCountedRun = undefined;

  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function renderResult() {
    if (!resultEl) return;
    const text = String(model.result || '');
    const has = !!text.trim();
    resultEl.style.display = has || model.run ? '' : 'none';
    resultEl.classList.toggle('empty', !has);
    doc.body.classList.toggle('has-result', has);
    if (has) resultEl.innerHTML = renderMarkdown(text);
    else resultEl.textContent = model.run ? 'No result yet.' : '';
  }

  function footerButton(label, title, onClick) {
    const b = el('span', 'rf-btn', label);
    b.title = title;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function renderFooter() {
    if (!footerEl) return;
    const f = fmt.formatFooter(model.run, model.state, now());
    footerEl.style.display = f.visible ? '' : 'none';
    footerEl.textContent = '';
    if (!f.visible) return;
    if (f.last) footerEl.appendChild(el('span', `rf-last rf-${model.state.last_status || 'none'}`, f.last));
    if (f.next) footerEl.appendChild(el('span', 'rf-next', f.next));
    if (f.target) footerEl.appendChild(el('span', 'rf-target', f.target));
    if (model.run) {
      footerEl.appendChild(
        footerButton(
          f.paused ? '▶ resume' : '⏸ pause',
          f.paused ? 'Resume this run' : 'Pause (unlocks the prompt)',
          () => togglePause()
        )
      );
      footerEl.appendChild(footerButton('Run now', 'Run once now; the schedule stays', () => runNow()));
    }
    const keep = model.run && model.run.history && model.run.history.keep;
    if (keep || model.historyCount) {
      const n = typeof model.historyCount === 'number' ? ` (${model.historyCount})` : '';
      const h = el('span', 'rf-link', `history${n}`);
      h.addEventListener('click', (e) => {
        e.stopPropagation();
        openHistory();
      });
      footerEl.appendChild(h);
    }
    if (f.error) footerEl.appendChild(el('span', 'rf-err', f.error));
  }

  function renderArmed() {
    const armed = fmt.isArmed(model.run);
    doc.body.classList.toggle('sched-armed', armed);
    if (textarea) textarea.readOnly = armed;
    if (lockHint) lockHint.style.display = armed ? '' : 'none';
    const btn = doc.getElementById('scheduleBtn');
    if (btn) {
      btn.classList.toggle('armed', armed);
      btn.classList.toggle('paused', !!model.run && !!model.run.paused);
      btn.title = fmt.tooltip(model.run, model.state, now());
    }
  }

  function render() {
    renderResult();
    renderFooter();
    renderArmed();
    maybeCountHistory();
  }

  function maybeCountHistory() {
    const key = model.run ? `${model.state.last_run || 0}` : null;
    if (key === lastCountedRun || !ctx.state.noteId || !model.run) return;
    lastCountedRun = key;
    const limit = (model.run.history && model.run.history.limit) || fmt.DEFAULT_HISTORY_LIMIT;
    Promise.resolve()
      .then(() => ipc.invoke('sticky-run-history', ctx.state.noteId, limit))
      .then((recs) => {
        model.historyCount = Array.isArray(recs) ? recs.length : null;
        renderFooter();
      })
      .catch(() => {
        model.historyCount = null;
      });
  }

  async function togglePause() {
    if (!model.run) return;
    const paused = !model.run.paused;
    try {
      const res = await ipc.invoke('sticky-run-pause', ctx.state.noteId, paused);
      if (!res || res.ok === false) throw new Error((res && res.error) || 'failed');
      model.run = {...model.run, paused};
      if (typeof res.next_run === 'number') model.state = {...model.state, next_run: res.next_run};
      render();
    } catch (e) {
      links.showToast(doc, `Couldn't ${paused ? 'pause' : 'resume'}: ${e.message || e}`);
    }
  }

  async function runNow() {
    try {
      const res = await ipc.invoke('sticky-run-now', ctx.state.noteId);
      if (!res || res.ok === false) throw new Error((res && res.error) || 'failed');
      links.showToast(doc, fmt.statusMessage({ok: true, status: res.status || 'running'}, now()));
    } catch (e) {
      links.showToast(doc, `Run failed to start: ${e.message || e}`);
    }
  }

  // History overlay: newest first, each result rendered as Markdown.
  const histOverlay = doc.getElementById('histOverlay');
  const histList = doc.getElementById('histList');
  function closeHistory() {
    if (histOverlay) histOverlay.style.display = 'none';
  }
  async function openHistory() {
    if (!histOverlay || !histList) return;
    histList.textContent = '';
    histList.appendChild(el('div', 'hist-empty', 'Loading…'));
    histOverlay.style.display = '';
    const limit = (model.run && model.run.history && model.run.history.limit) || fmt.DEFAULT_HISTORY_LIMIT;
    let recs = [];
    try {
      recs = await ipc.invoke('sticky-run-history', ctx.state.noteId, limit);
    } catch (e) {
      histList.textContent = '';
      histList.appendChild(el('div', 'hist-err', `Couldn't load history: ${e.message || e}`));
      return;
    }
    renderHistory(histList, Array.isArray(recs) ? recs : []);
  }
  function renderHistory(list, recs) {
    list.textContent = '';
    if (!recs.length) {
      list.appendChild(el('div', 'hist-empty', 'No runs recorded yet.'));
      return;
    }
    const t = now();
    for (const r of recs) {
      const item = el('div', 'hist-item');
      const meta = el('div', 'hist-meta');
      const st = fmt.STATUS[r.status];
      meta.appendChild(el('span', `rf-${r.status}`, st ? `${st.glyph} ${st.label}` : String(r.status || '?')));
      meta.appendChild(el('span', '', fmt.formatAbsolute(r.finished || r.started, t)));
      const tgt =
        r.target === 'pane' && r.pane ? `→ pane ${r.pane.name || r.pane.uid}` : r.agent ? r.agent.provider : r.target;
      if (tgt) meta.appendChild(el('span', 'hist-target', tgt));
      item.appendChild(meta);
      if (r.error) item.appendChild(el('div', 'hist-err', String(r.error)));
      if (r.result && String(r.result).trim()) {
        const body = el('div', 'md');
        body.innerHTML = renderMarkdown(String(r.result));
        item.appendChild(body);
      }
      list.appendChild(item);
    }
  }
  if (histOverlay) {
    const x = doc.getElementById('histClose');
    if (x) x.addEventListener('click', closeHistory);
    histOverlay.addEventListener('click', (e) => {
      if (e.target === histOverlay) closeHistory();
    });
    links.bindRenderedLinks(histList, ipc);
  }
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && histOverlay && histOverlay.style.display !== 'none') {
      e.preventDefault();
      closeHistory();
    }
  });

  function mount(opts) {
    textarea = opts.textarea;
    const content = opts.content;
    lockHint = el('div', 'prompt-lock-hint', 'Pause to edit');
    lockHint.style.display = 'none';
    if (opts.promptWrap) opts.promptWrap.appendChild(lockHint);
    resultEl = el('div', 'run-result md');
    resultEl.id = 'runResult';
    footerEl = el('div', 'run-footer');
    footerEl.id = 'runFooter';
    content.appendChild(resultEl);
    content.appendChild(footerEl);
    links.bindRenderedLinks(resultEl, ipc);
    render();
    timers.setInterval(() => {
      renderFooter();
      renderArmed();
    }, 30000);
  }

  ipc.on('sticky-run-state', (_e, runState, run) => {
    model.state = runState || {};
    if (run !== undefined) model.run = run || null;
    render();
  });
  ipc.on('sticky-result', (_e, result) => {
    model.result = typeof result === 'string' ? result : '';
    renderResult();
  });

  // Called by the panel after set/clear so the UI updates before the push arrives.
  function setRun(run, statePatch) {
    model.run = run || null;
    if (statePatch) model.state = {...model.state, ...statePatch};
    if (!run) model.state = {...model.state, next_run: undefined};
    render();
  }

  return {mount, render, setRun, openHistory, renderHistory, model};
}

module.exports = {createRunView};
