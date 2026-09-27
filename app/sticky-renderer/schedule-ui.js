// Run panel: When (Now/At/Every) × Run (Notify/Agent/Pane) + history, via the
// sticky-run-* IPC. Field <-> run conversion lives in run-format.js.
'use strict';

const fmt = require('./run-format');
const links = require('./links');
const {defaultTimers} = require('./timers');

function start(ctx) {
  const {doc, ipc, persist} = ctx;
  const $ = (id) => doc.getElementById(id);
  const overlay = $('schedOverlay');
  if (!overlay) return null;
  const timers = ctx.timers || defaultTimers();
  const now = ctx.now || (() => Date.now());
  const homeDir = () => {
    try {
      return persist.os.homedir();
    } catch (e) {
      return '';
    }
  };

  let fields = fmt.defaultFields(now(), homeDir());
  let current = null;
  let n8 = null;
  let busy = false;
  let closeTimer = null;

  const dayChips = [];
  const daysBox = $('weeklyDays');
  fmt.DAY_NAMES.forEach((name, i) => {
    const chip = doc.createElement('span');
    chip.className = 'day';
    chip.textContent = name;
    chip.addEventListener('click', () => {
      chip.classList.toggle('on');
      fields.weeklyDays = dayChips.map((c, k) => (c.classList.contains('on') ? k : -1)).filter((k) => k >= 0);
    });
    dayChips[i] = chip;
    if (daysBox) daysBox.appendChild(chip);
  });

  const show = (id, on) => {
    const e = $(id);
    if (e) e.style.display = on ? '' : 'none';
  };
  function setSeg(id, value) {
    for (const s of $(id).querySelectorAll('span[data-v]'))
      s.classList.toggle('on', s.getAttribute('data-v') === value);
  }

  function writeFields(f) {
    setSeg('segWhen', f.when);
    setSeg('segTarget', f.target);
    $('runAt').value = f.at;
    $('everyKind').value = f.everyKind;
    $('intervalN').value = f.intervalN;
    $('intervalUnit').value = f.intervalUnit;
    $('dailyTime').value = f.dailyTime;
    $('weeklyTime').value = f.weeklyTime;
    dayChips.forEach((c, k) => c.classList.toggle('on', f.weeklyDays.includes(k)));
    $('cronExpr').value = f.cron;
    $('agentDir').value = f.dir;
    $('agentDanger').checked = !!f.danger;
    $('historyKeep').checked = !!f.historyKeep;
    $('historyLimit').value = f.historyLimit;
  }

  function readFields() {
    const sel = $('paneSelect');
    const opt = sel.selectedOptions && sel.selectedOptions[0];
    return {
      ...fields,
      at: $('runAt').value,
      everyKind: $('everyKind').value,
      intervalN: $('intervalN').value,
      intervalUnit: $('intervalUnit').value,
      dailyTime: $('dailyTime').value,
      weeklyTime: $('weeklyTime').value,
      cron: $('cronExpr').value,
      provider: $('agentProvider').value,
      dir: $('agentDir').value,
      danger: $('agentDanger').checked,
      paneUid: sel.value,
      paneName: (opt && opt.getAttribute('data-name')) || sel.value,
      historyKeep: $('historyKeep').checked,
      historyLimit: $('historyLimit').value
    };
  }

  function n8Usable() {
    return !n8 || n8.installed !== false;
  }

  function sync() {
    const kind = $('everyKind').value;
    show('rowAt', fields.when === 'at');
    show('rowEvery', fields.when === 'every');
    show('rowInterval', kind === 'interval');
    show('rowDaily', kind === 'daily');
    show('rowWeekly', kind === 'weekly');
    show('rowWeeklyTime', kind === 'weekly');
    show('rowCron', kind === 'cron');
    show('rowAgent', fields.target === 'agent');
    show('rowPane', fields.target === 'pane');
    show('schedRunNow', fields.when === 'now');
    show('schedConfirm', fields.when !== 'now');
    show('schedUnschedule', !!current);
    $('schedConfirm').textContent = current ? 'Reschedule' : 'Schedule';
    $('historyLimit').disabled = !$('historyKeep').checked;
    const blockAgent = fields.target === 'agent' && !n8Usable();
    for (const id of ['schedRunNow', 'schedConfirm']) $(id).classList.toggle('disabled', busy || blockAgent);
  }

  function showError(msg) {
    $('runError').textContent = msg || '';
    show('runError', !!msg);
    if (msg) show('runStatus', false);
  }
  function showStatus(msg) {
    $('runStatus').textContent = msg || '';
    show('runStatus', !!msg);
  }

  function actionLink(text, onClick) {
    const a = doc.createElement('a');
    a.textContent = text;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return a;
  }

  // nemesis8 state drives the Agent option: missing → disabled + links, stopped → Start.
  function renderN8() {
    const notice = $('n8Notice');
    const agentFields = ['agentProvider', 'agentDir', 'agentDanger', 'agentPickDir'];
    notice.textContent = '';
    const installed = !n8 || n8.installed !== false;
    for (const id of agentFields) {
      const e = $(id);
      if (!e) continue;
      if ('disabled' in e && e.tagName !== 'SPAN') e.disabled = !installed;
      e.classList.toggle('disabled-block', !installed);
    }
    if (!n8) {
      show('n8Notice', false);
      return;
    }
    if (n8.error) {
      notice.appendChild(doc.createTextNode(`Couldn't check nemesis8: ${n8.error}`));
    } else if (n8.installed === false) {
      notice.appendChild(doc.createTextNode("nemesis8 isn't installed — "));
      notice.appendChild(
        actionLink('Config → nemesis8', () => n8.config_path && ipc.send('sticky-open-file', n8.config_path))
      );
      if (n8.install_url) {
        notice.appendChild(doc.createTextNode(' · '));
        notice.appendChild(actionLink('install', () => links.openLink(ipc, {kind: 'url', value: n8.install_url})));
      }
    } else if (!n8.running) {
      notice.appendChild(doc.createTextNode("nemesis8 isn't running."));
      const b = doc.createElement('span');
      b.className = 'sched-btn';
      b.id = 'n8Start';
      b.textContent = 'Start';
      b.addEventListener('click', startN8);
      notice.appendChild(b);
      const hint = doc.createElement('div');
      hint.className = 'sched-hint';
      hint.textContent = 'Runs will also try to start it automatically.';
      notice.appendChild(hint);
    } else {
      show('n8Notice', false);
      return;
    }
    show('n8Notice', true);
  }

  function fillProviders() {
    const sel = $('agentProvider');
    sel.textContent = '';
    const opts = fmt.providerOptions(n8 && n8.providers);
    if (fields.provider && !opts.some((o) => o.value === fields.provider)) {
      opts.unshift({value: fields.provider, label: `${fields.provider} ?`, disabled: false});
    }
    if (!opts.length) opts.push({value: '', label: n8 ? 'No agents found' : 'Loading…', disabled: true});
    for (const o of opts) {
      const e = doc.createElement('option');
      e.value = o.value;
      e.textContent = o.label;
      e.disabled = !!o.disabled;
      sel.appendChild(e);
    }
    const pick = fields.provider || (opts.find((o) => !o.disabled) || {}).value || '';
    sel.value = pick;
  }

  async function loadN8() {
    try {
      n8 = (await ipc.invoke('sticky-n8-status')) || {installed: false};
    } catch (e) {
      n8 = {error: e.message || String(e), installed: undefined, running: false, providers: []};
    }
    fillProviders();
    renderN8();
    sync();
  }

  async function startN8() {
    const b = $('n8Start');
    if (b) {
      b.textContent = 'Starting…';
      b.classList.add('disabled');
    }
    try {
      const res = await ipc.invoke('sticky-n8-start');
      if (!res || !res.running) showError(`nemesis8 didn't start${res && res.error ? `: ${res.error}` : ''}`);
    } catch (e) {
      showError(`nemesis8 didn't start: ${e.message || e}`);
    }
    await loadN8();
  }

  async function loadPanes(savedUid, savedName) {
    const sel = $('paneSelect');
    sel.textContent = '';
    let panes = [];
    try {
      panes = (await ipc.invoke('sticky-run-panes')) || [];
    } catch (e) {
      panes = [];
    }
    const add = (value, label, name, disabled) => {
      const o = doc.createElement('option');
      o.value = value;
      o.textContent = label;
      o.setAttribute('data-name', name);
      o.disabled = !!disabled;
      sel.appendChild(o);
    };
    for (const p of panes) add(p.uid, fmt.paneLabel(p), p.name || p.uid);
    if (savedUid && !panes.some((p) => p.uid === savedUid)) {
      add(savedUid, `${savedName || savedUid} (closed)`, savedName || savedUid);
    }
    if (!sel.options.length) add('', 'No open panes', '', true);
    sel.value = savedUid || (panes[0] && panes[0].uid) || '';
  }

  function openPanel() {
    if (closeTimer) timers.clearTimeout(closeTimer);
    const model = ctx.runView && ctx.runView.model;
    const note = ctx.state.noteId ? persist.findNote(ctx.state.noteId) : null;
    current = (model && model.run) || (note && note.run) || null;
    fields = fmt.prefillFromRun(current, now(), homeDir());
    busy = false;
    writeFields(fields);
    showError('');
    showStatus('');
    fillProviders();
    renderN8();
    sync();
    overlay.style.display = '';
    void loadN8();
    void loadPanes(fields.paneUid, fields.paneName);
  }
  function closePanel() {
    overlay.style.display = 'none';
  }

  async function submit() {
    if (busy) return;
    const f = readFields();
    fields = f;
    if (f.target === 'agent' && !n8Usable()) return showError("nemesis8 isn't installed — see Config → nemesis8.");
    const built = fmt.buildRun(f);
    if (!built.ok) return showError(built.error);
    busy = true;
    sync();
    showError('');
    showStatus(f.when === 'now' ? 'Starting…' : 'Saving…');
    let res;
    try {
      res = await ipc.invoke('sticky-run-set', ctx.state.noteId, built.run);
    } catch (e) {
      res = {ok: false, error: e.message || String(e)};
    }
    busy = false;
    sync();
    if (!res || !res.ok) {
      showStatus('');
      return showError((res && res.error) || 'Could not save the run.');
    }
    const msg = fmt.statusMessage(res, now());
    showStatus(msg);
    current = built.run;
    if (ctx.runView) {
      const patch = {};
      if (typeof res.next_run === 'number') patch.next_run = res.next_run;
      if (res.status && fmt.STATUS[res.status]) patch.last_status = res.status;
      ctx.runView.setRun(built.run, patch);
    }
    links.showToast(doc, msg);
    closeTimer = timers.setTimeout(closePanel, res.status === 'awaiting_approval' ? 2500 : 1200);
  }

  async function unschedule() {
    try {
      const res = await ipc.invoke('sticky-run-clear', ctx.state.noteId);
      if (res && res.ok === false) return showError(res.error || 'Could not unschedule.');
    } catch (e) {
      return showError(e.message || String(e));
    }
    current = null;
    if (ctx.runView) ctx.runView.setRun(null);
    closePanel();
  }

  for (const [id, key] of [
    ['segWhen', 'when'],
    ['segTarget', 'target']
  ]) {
    $(id).addEventListener('click', (e) => {
      const v = e.target && e.target.getAttribute && e.target.getAttribute('data-v');
      if (!v) return;
      fields = {...readFields(), [key]: v};
      setSeg(id, v);
      showError('');
      sync();
    });
  }
  $('everyKind').addEventListener('change', sync);
  $('historyKeep').addEventListener('change', sync);
  $('agentProvider').addEventListener('change', () => {
    fields.provider = $('agentProvider').value;
  });
  $('agentPickDir').addEventListener('click', async () => {
    const dir = await ipc.invoke('sticky-pick-dir');
    if (dir) $('agentDir').value = dir;
  });
  const scheduleBtn = $('scheduleBtn');
  if (scheduleBtn) {
    scheduleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPanel();
    });
  }
  $('schedCancel').addEventListener('click', closePanel);
  $('schedCancelBtn').addEventListener('click', closePanel);
  $('schedRunNow').addEventListener('click', () => void submit());
  $('schedConfirm').addEventListener('click', () => void submit());
  $('schedUnschedule').addEventListener('click', () => void unschedule());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePanel();
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') {
      e.preventDefault();
      closePanel();
    }
  });

  return {openPanel, closePanel, submit, readFields, sync};
}

module.exports = {start};
