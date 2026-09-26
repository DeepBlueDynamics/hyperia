// Pure timing and validation for sticky runs (no electron imports, so unit-testable).
import type {RunEvery, StickyRun} from '../types';

// ── Cron (5-field, vixie semantics) ────────────────────────────────────────

export type CronSpec = {
  minutes: Set<number>;
  hours: Set<number>;
  dom: Set<number>;
  months: Set<number>; // 1-12
  dow: Set<number>; // 0-6, Sunday = 0 (7 is folded in)
  domStar: boolean;
  dowStar: boolean;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
};

type FieldDef = {name: string; min: number; max: number; names?: string[]; namesBase?: number};
const FIELDS: FieldDef[] = [
  {name: 'minute', min: 0, max: 59},
  {name: 'hour', min: 0, max: 23},
  {name: 'day-of-month', min: 1, max: 31},
  {name: 'month', min: 1, max: 12, names: MONTHS, namesBase: 1},
  {name: 'day-of-week', min: 0, max: 7, names: DAYS, namesBase: 0}
];

function parseValue(tok: string, f: FieldDef): number {
  const lower = tok.toLowerCase();
  if (f.names) {
    const i = f.names.indexOf(lower);
    if (i >= 0) return i + (f.namesBase || 0);
  }
  if (!/^\d+$/.test(tok)) throw new Error(`${f.name}: "${tok}" is not a number`);
  const n = Number(tok);
  if (n < f.min || n > f.max) throw new Error(`${f.name}: ${n} is outside ${f.min}-${f.max}`);
  return n;
}

function parseField(src: string, f: FieldDef): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    if (!part) throw new Error(`${f.name}: empty list item`);
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`${f.name}: bad step in "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new Error(`${f.name}: step must be >= 1`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = f.min;
      hi = f.name === 'day-of-week' ? 6 : f.max;
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-');
      if (more !== undefined) throw new Error(`${f.name}: bad range "${rangePart}"`);
      lo = parseValue(a, f);
      hi = parseValue(b, f);
      if (lo > hi) throw new Error(`${f.name}: range ${rangePart} runs backwards`);
    } else {
      lo = parseValue(rangePart, f);
      // "a/n" means a through the field max, every n.
      hi = stepPart !== undefined ? f.max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(f.name === 'day-of-week' && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const src = (expr || '').trim();
  const expanded = MACROS[src.toLowerCase()] || src;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields (minute hour day month weekday), got ${parts.length}`);
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]));
  return {
    minutes: sets[0],
    hours: sets[1],
    dom: sets[2],
    months: sets[3],
    dow: sets[4],
    // Vixie cron: a field starting with '*' is unrestricted for the dom/dow OR rule.
    domStar: parts[2].startsWith('*'),
    dowStar: parts[4].startsWith('*')
  };
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.months.has(d.getMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getDate());
  const dowOk = spec.dow.has(d.getDay());
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowOk;
  if (spec.dowStar) return domOk;
  return domOk || dowOk; // both restricted: standard cron ORs them
}

const sorted = (s: Set<number>) => Array.from(s).sort((a, b) => a - b);

/** Next local-time fire strictly after `from`, or undefined if none within ~11 years. */
export function cronNext(spec: CronSpec, from: number): number | undefined {
  const hours = sorted(spec.hours);
  const minutes = sorted(spec.minutes);
  const start = new Date(from);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < 4020; i++) {
    if (dayMatches(spec, day)) {
      for (const h of hours) {
        for (const m of minutes) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
          // A wall time skipped by DST normalizes to another hour; skip it rather than fire at the wrong time.
          if (t.getHours() !== h || t.getMinutes() !== m) continue;
          if (t.getTime() > from) return t.getTime();
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return undefined;
}

// ── Every / At / Now ───────────────────────────────────────────────────────

export function parseHHMM(time: string): {h: number; m: number} | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time || '').trim());
  if (!match) return undefined;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return undefined;
  return {h, m};
}

/** Next local wall-clock HH:MM on an allowed weekday, strictly after `from` (calendar days, so DST-safe). */
function nextWallClock(time: string, days: number[] | null, from: number): number | undefined {
  const hm = parseHHMM(time);
  if (!hm) return undefined;
  const start = new Date(from);
  for (let i = 0; i < 9; i++) {
    const t = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, hm.h, hm.m);
    if (days && !days.includes(t.getDay())) continue;
    // In a spring-forward gap JS moves the time forward an hour; that's the right fire time.
    if (t.getTime() > from) return t.getTime();
  }
  return undefined;
}

export function nextEvery(every: RunEvery, from: number): number | undefined {
  switch (every.kind) {
    case 'interval':
      return every.minutes >= 1 ? from + Math.round(every.minutes * 60000) : undefined;
    case 'daily':
      return nextWallClock(every.time, null, from);
    case 'weekly':
      return nextWallClock(every.time, every.days, from);
    case 'cron':
      try {
        return cronNext(parseCron(every.expr), from);
      } catch {
        return undefined;
      }
    default:
      return undefined;
  }
}

/** First fire time for a freshly set run. */
export function firstRun(run: StickyRun, now: number): number | undefined {
  if (run.when === 'now') return now;
  if (run.when === 'at') {
    const t = Date.parse(run.at || '');
    return isNaN(t) ? undefined : t;
  }
  return run.every ? nextEvery(run.every, now) : undefined;
}

// ── Validation ─────────────────────────────────────────────────────────────

export const DEFAULT_HISTORY_LIMIT = 50;
const AT_PAST_GRACE_MS = 60_000;

function validateEvery(every: RunEvery | undefined): string | null {
  if (!every || typeof every !== 'object') return 'Every needs a schedule (interval, daily, weekly or cron).';
  switch (every.kind) {
    case 'interval':
      if (!Number.isInteger(every.minutes) || every.minutes < 1)
        return 'Interval must be a whole number of minutes, at least 1.';
      if (every.minutes > 60 * 24 * 366) return 'Interval must be at most a year.';
      return null;
    case 'daily':
      return parseHHMM(every.time) ? null : 'Daily time must be HH:MM (24-hour).';
    case 'weekly':
      if (!parseHHMM(every.time)) return 'Weekly time must be HH:MM (24-hour).';
      if (!Array.isArray(every.days) || every.days.length === 0) return 'Pick at least one weekday.';
      if (every.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Weekdays are 0 (Sun) to 6 (Sat).';
      return null;
    case 'cron':
      try {
        const spec = parseCron(every.expr);
        if (cronNext(spec, Date.now()) === undefined) return 'That cron expression never fires.';
        return null;
      } catch (e) {
        return `Bad cron: ${(e as Error).message}`;
      }
    default:
      return `Unknown Every kind "${(every as {kind?: string}).kind}".`;
  }
}

/** Returns a readable error, or null when the run is valid. */
export function validateRun(run: StickyRun | null | undefined, now: number = Date.now()): string | null {
  if (!run || typeof run !== 'object') return 'A run is required.';
  if (run.when === 'at') {
    if (!run.at) return 'At needs a date and time.';
    const t = Date.parse(run.at);
    if (isNaN(t)) return `"${run.at}" is not a valid date/time.`;
    if (t < now - AT_PAST_GRACE_MS) return 'That time is in the past.';
  } else if (run.when === 'every') {
    const e = validateEvery(run.every);
    if (e) return e;
  } else if (run.when !== 'now') {
    return `When must be now, at or every (got "${String(run.when)}").`;
  }
  if (run.target === 'agent') {
    const a = run.agent;
    if (!a || typeof a !== 'object') return 'Agent runs need an agent.';
    if (typeof a.provider !== 'string' || !a.provider.trim()) return 'Pick an agent provider.';
    if (typeof a.dir !== 'string' || !a.dir.trim()) return 'Pick a directory to mount.';
    if (a.image !== undefined && a.image !== 'default') return 'Only the default image is supported for now.';
    if (a.danger !== undefined && typeof a.danger !== 'boolean') return 'danger must be true or false.';
  } else if (run.target === 'pane') {
    if (!run.pane || typeof run.pane.uid !== 'string' || !run.pane.uid.trim()) return 'Pick a target pane.';
  } else if (run.target !== 'notify') {
    return `Run must be notify, agent or pane (got "${String(run.target)}").`;
  }
  if (run.history !== undefined && run.history !== null) {
    const h = run.history;
    if (typeof h.keep !== 'boolean') return 'history.keep must be true or false.';
    if (h.limit !== undefined && (!Number.isInteger(h.limit) || h.limit < 1 || h.limit > 1000)) {
      return 'history.limit must be 1 to 1000.';
    }
  }
  return null;
}

/** Agent-made runs and every pane target need a human approval before they fire. */
export function needsApproval(run: StickyRun): boolean {
  if (run.approved && typeof run.approved.at === 'number') return false;
  return run.target === 'pane' || (!!run.created_by && run.created_by !== 'human');
}

export function historyLimit(run: StickyRun | null | undefined): number {
  const l = run?.history?.limit;
  return Number.isInteger(l) && (l as number) > 0 ? (l as number) : DEFAULT_HISTORY_LIMIT;
}
