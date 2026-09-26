// Pure helpers for sticky runs: footer/tooltip text and panel fields <-> StickyRun.
// No DOM, no IPC, so it is unit-testable.
'use strict';

const STATUS = Object.freeze({
  ok: {glyph: '✓', label: 'ran'},
  failed: {glyph: '✗', label: 'failed'},
  halted: {glyph: '⏸', label: 'halted'},
  skipped: {glyph: '⏭', label: 'skipped'},
  running: {glyph: '⟳', label: 'running'},
  awaiting_approval: {glyph: '⌛', label: 'awaiting approval'}
});

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DEFAULT_HISTORY_LIMIT = 50;

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// "08:00 today", "08:00 tomorrow", "08:00 yesterday", "Mon 08:00" (this week), else "Sep 28 08:00".
function formatAbsolute(ms, now) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '';
  const d = new Date(ms);
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86400000);
  if (days === 0) return `${hhmm(d)} today`;
  if (days === 1) return `${hhmm(d)} tomorrow`;
  if (days === -1) return `${hhmm(d)} yesterday`;
  if (days > 1 && days < 7) return `${DAY_NAMES[d.getDay()]} ${hhmm(d)}`;
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year} ${hhmm(d)}`;
}

// "in 5m", "in 2h 10m", "in 3d", "5m ago", "now".
function formatRelative(ms, now) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '';
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 45000) return 'now';
  const mins = Math.round(abs / 60000);
  let text;
  if (mins < 60) text = `${mins}m`;
  else if (mins < 60 * 24) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    text = m ? `${h}h ${m}m` : `${h}h`;
  } else {
    const totalH = Math.round(mins / 60);
    const dd = Math.floor(totalH / 24);
    const h = totalH % 24;
    text = h && dd < 3 ? `${dd}d ${h}h` : `${dd}d`;
  }
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

function everyLabel(every) {
  if (!every) return '';
  if (every.kind === 'interval') {
    const m = Number(every.minutes) || 0;
    return m % 60 === 0 && m >= 60 ? `every ${m / 60}h` : `every ${m}m`;
  }
  if (every.kind === 'daily') return `daily ${every.time}`;
  if (every.kind === 'weekly') {
    const days = (every.days || []).slice().sort((a, b) => a - b);
    const names = days.length === 7 ? 'every day' : days.map((d) => DAY_NAMES[d]).join(', ');
    return `${names} ${every.time}`;
  }
  if (every.kind === 'cron') return `cron ${every.expr}`;
  return '';
}

function whenLabel(run, now) {
  if (!run) return '';
  if (run.when === 'now') return 'once, now';
  if (run.when === 'at') return `once at ${formatAbsolute(Date.parse(run.at), now)}`;
  if (run.when === 'every') return everyLabel(run.every);
  return '';
}

function targetLabel(run) {
  if (!run) return '';
  if (run.target === 'agent') return (run.agent && run.agent.provider) || 'agent';
  if (run.target === 'pane') return `→ pane ${(run.pane && run.pane.name) || '?'}`;
  return 'notify';
}

// Armed = the prompt is locked server-side (run set and not paused).
function isArmed(run) {
  return !!run && !run.paused;
}

// Footer text pieces; empty strings mean "hide that piece".
function formatFooter(run, state, now) {
  state = state || {};
  const f = {visible: !!run || !!state.last_status, last: '', error: '', next: '', target: '', paused: false};
  const st = STATUS[state.last_status];
  if (st) {
    const when = state.last_run ? ` ${formatAbsolute(state.last_run, now)}` : '';
    f.last =
      state.last_status === 'running' || state.last_status === 'awaiting_approval'
        ? `${st.glyph} ${st.label}`
        : `${st.glyph} ${st.label}${when}`;
  } else if (run) {
    f.last = 'not run yet';
  }
  if (state.last_error) f.error = String(state.last_error);
  if (run) {
    f.paused = !!run.paused;
    f.target = targetLabel(run);
    if (run.paused) f.next = 'paused';
    else if (typeof state.next_run === 'number') {
      f.next = `next ${formatRelative(state.next_run, now)} (${formatAbsolute(state.next_run, now)})`;
    } else if (run.when === 'every') f.next = everyLabel(run.every);
  }
  return f;
}

function tooltip(run, state, now) {
  if (!run) return 'Run this sticky (now, at a time, or on a schedule)';
  state = state || {};
  const parts = [`${whenLabel(run, now)} · ${targetLabel(run)}`];
  if (run.paused) parts.push('Paused');
  else if (typeof state.next_run === 'number')
    parts.push(`Next run: ${formatRelative(state.next_run, now)} (${formatAbsolute(state.next_run, now)})`);
  if (state.last_status && STATUS[state.last_status])
    parts.push(`Last: ${STATUS[state.last_status].glyph} ${STATUS[state.last_status].label}`);
  return parts.join('\n');
}

function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${hhmm(d)}`;
}

function defaultFields(now, homeDir) {
  return {
    when: 'now',
    at: toLocalInput((now || Date.now()) + 3600000),
    everyKind: 'interval',
    intervalN: 15,
    intervalUnit: 'm',
    dailyTime: '08:00',
    weeklyDays: [1, 2, 3, 4, 5],
    weeklyTime: '08:00',
    cron: '',
    target: 'notify',
    provider: '',
    model: '',
    dir: homeDir || '',
    danger: false,
    paneUid: '',
    paneName: '',
    historyKeep: false,
    historyLimit: DEFAULT_HISTORY_LIMIT
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Panel fields → {ok, run} or {ok:false, error}. The engine re-validates.
function buildRun(f) {
  const run = {when: f.when, target: f.target};
  if (f.when === 'at') {
    const ms = Date.parse(f.at || '');
    if (!f.at || !isFinite(ms)) return {ok: false, error: 'Pick a date and time.'};
    run.at = new Date(ms).toISOString();
  } else if (f.when === 'every') {
    if (f.everyKind === 'interval') {
      const n = Number(f.intervalN);
      if (!Number.isInteger(n) || n < 1)
        return {ok: false, error: 'The interval must be a whole number of at least 1.'};
      run.every = {kind: 'interval', minutes: f.intervalUnit === 'h' ? n * 60 : n};
    } else if (f.everyKind === 'daily') {
      if (!TIME_RE.test(f.dailyTime || '')) return {ok: false, error: 'Pick a time (HH:MM).'};
      run.every = {kind: 'daily', time: f.dailyTime};
    } else if (f.everyKind === 'weekly') {
      const days = [...new Set((f.weeklyDays || []).map(Number))].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
      if (!days.length) return {ok: false, error: 'Pick at least one day.'};
      if (!TIME_RE.test(f.weeklyTime || '')) return {ok: false, error: 'Pick a time (HH:MM).'};
      run.every = {kind: 'weekly', days, time: f.weeklyTime};
    } else if (f.everyKind === 'cron') {
      const expr = String(f.cron || '')
        .trim()
        .replace(/\s+/g, ' ');
      if (expr.split(' ').length !== 5)
        return {ok: false, error: 'Cron needs 5 fields: minute hour day month weekday.'};
      run.every = {kind: 'cron', expr};
    } else return {ok: false, error: 'Pick how often to run.'};
  } else if (f.when !== 'now') return {ok: false, error: 'Pick when to run.'};

  if (f.target === 'agent') {
    if (!f.provider) return {ok: false, error: 'Pick an agent.'};
    const dir = String(f.dir || '').trim();
    if (!dir) return {ok: false, error: 'Pick a directory for the agent.'};
    run.agent = {provider: f.provider, image: 'default', dir, danger: !!f.danger};
    if (f.model) run.agent.model = f.model;
  } else if (f.target === 'pane') {
    if (!f.paneUid) return {ok: false, error: 'Pick a pane.'};
    run.pane = {uid: f.paneUid, name: f.paneName || f.paneUid};
  } else if (f.target !== 'notify') return {ok: false, error: 'Pick what to run.'};

  if (f.historyKeep) {
    const limit = Number(f.historyLimit);
    run.history = {keep: true, limit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_HISTORY_LIMIT};
  }
  return {ok: true, run};
}

// Saved run → panel fields (inverse of buildRun), on top of the defaults.
function prefillFromRun(run, now, homeDir) {
  const f = defaultFields(now, homeDir);
  if (!run) return f;
  f.when = run.when || 'now';
  if (run.when === 'at' && run.at && isFinite(Date.parse(run.at))) f.at = toLocalInput(Date.parse(run.at));
  const e = run.every;
  if (run.when === 'every' && e) {
    f.everyKind = e.kind;
    if (e.kind === 'interval') {
      const m = Number(e.minutes) || 1;
      if (m >= 60 && m % 60 === 0) {
        f.intervalN = m / 60;
        f.intervalUnit = 'h';
      } else {
        f.intervalN = m;
        f.intervalUnit = 'm';
      }
    } else if (e.kind === 'daily') f.dailyTime = e.time;
    else if (e.kind === 'weekly') {
      f.weeklyDays = (e.days || []).slice();
      f.weeklyTime = e.time;
    } else if (e.kind === 'cron') f.cron = e.expr;
  }
  f.target = run.target || 'notify';
  if (run.agent) {
    f.provider = run.agent.provider || '';
    f.model = run.agent.model || '';
    f.dir = run.agent.dir || f.dir;
    f.danger = !!run.agent.danger;
  }
  if (run.pane) {
    f.paneUid = run.pane.uid || '';
    f.paneName = run.pane.name || '';
  }
  if (run.history) {
    f.historyKeep = !!run.history.keep;
    f.historyLimit = run.history.limit || DEFAULT_HISTORY_LIMIT;
  }
  return f;
}

// Installed first, then unknown (null), then missing; label marks the latter two.
function providerOptions(providers) {
  const rank = (p) => (p.installed === true ? 0 : p.installed === null || p.installed === undefined ? 1 : 2);
  return (Array.isArray(providers) ? providers : [])
    .filter((p) => p && p.name)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)))
    .map((p) => {
      const r = rank(p);
      return {
        value: p.name,
        label: r === 0 ? p.name : r === 1 ? `${p.name} ?` : `${p.name} (not installed)`,
        disabled: r === 2
      };
    });
}

function paneLabel(p) {
  return [p.name || p.uid, p.tab, p.app].filter(Boolean).join(' · ');
}

// Message for a successful sticky-run-set / sticky-run-now reply.
function statusMessage(res, now) {
  if (!res || !res.ok) return '';
  if (res.status === 'awaiting_approval') return 'Waiting for your approval in Hyperia';
  if (res.status === 'running') return '⟳ Running now';
  const next = typeof res.next_run === 'number' ? ` · next ${formatRelative(res.next_run, now)}` : '';
  const st = STATUS[res.status];
  if (st && res.status !== 'ok') return `${st.glyph} ${st.label}${next}`;
  return `Scheduled${res.status && !st ? ` (${res.status})` : ''}${next}`;
}

module.exports = {
  STATUS,
  DAY_NAMES,
  DEFAULT_HISTORY_LIMIT,
  formatAbsolute,
  formatRelative,
  everyLabel,
  whenLabel,
  targetLabel,
  isArmed,
  formatFooter,
  tooltip,
  toLocalInput,
  defaultFields,
  buildRun,
  prefillFromRun,
  providerOptions,
  paneLabel,
  statusMessage
};
