/* eslint-disable eslint-comments/disable-enable-pair */
// Pure timing/validation for sticky runs. US Eastern so DST transitions are exercised.
process.env.TZ = 'America/New_York';

import test from 'ava';

import {isSafeExternalUrl} from '../../app/sticky/external-url';
import {buildAgentPrompt, buildPanePrompt} from '../../app/sticky/runs/prompt';
import {cronNext, firstRun, needsApproval, nextEvery, parseCron, validateRun} from '../../app/sticky/runs/schedule';
import type {NoteData, RunRecord, StickyRun} from '../../app/sticky/types';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const HOUR = 3600000;
const cron = (expr: string, from: number) => cronNext(parseCron(expr), from);

test('TZ is honoured (DST offsets differ across March 8 2026)', (t) => {
  t.not(new Date(2026, 2, 7).getTimezoneOffset(), new Date(2026, 2, 9).getTimezoneOffset());
});

// ── next_run: interval / daily / weekly ──────────────────────────────────

test('interval adds minutes', (t) => {
  const from = local(2026, 5, 1, 10, 0);
  t.is(nextEvery({kind: 'interval', minutes: 90}, from), from + 90 * 60000);
});

test('daily: later today, else tomorrow', (t) => {
  t.is(nextEvery({kind: 'daily', time: '09:00'}, local(2026, 5, 1, 8, 0)), local(2026, 5, 1, 9, 0));
  t.is(nextEvery({kind: 'daily', time: '09:00'}, local(2026, 5, 1, 9, 0)), local(2026, 5, 2, 9, 0));
});

test('daily across spring-forward keeps 09:00 wall time (23 h gap)', (t) => {
  const from = local(2026, 3, 7, 9, 30);
  const next = nextEvery({kind: 'daily', time: '09:00'}, from) as number;
  t.is(new Date(next).getHours(), 9);
  t.is(new Date(next).getDate(), 8);
  t.is(next - local(2026, 3, 7, 9, 0), 23 * HOUR);
});

test('daily across fall-back keeps 09:00 wall time (25 h gap)', (t) => {
  const next = nextEvery({kind: 'daily', time: '09:00'}, local(2026, 10, 31, 9, 30)) as number;
  t.is(new Date(next).getHours(), 9);
  t.is(next - local(2026, 10, 31, 9, 0), 25 * HOUR);
});

test('daily at a time inside the spring-forward gap fires once that day, just after the gap', (t) => {
  const next = nextEvery({kind: 'daily', time: '02:30'}, local(2026, 3, 8, 0, 0)) as number;
  t.is(new Date(next).getDate(), 8);
  t.is(new Date(next).getHours(), 3);
  const after = nextEvery({kind: 'daily', time: '02:30'}, next) as number;
  t.is(new Date(after).getDate(), 9);
  t.is(new Date(after).getHours(), 2);
});

test('weekly picks the next listed weekday', (t) => {
  // 2026-05-02 is a Saturday.
  const next = nextEvery({kind: 'weekly', days: [1, 3, 5], time: '08:00'}, local(2026, 5, 2, 12, 0)) as number;
  t.is(new Date(next).getDay(), 1);
  t.is(next, local(2026, 5, 4, 8, 0));
  // Same day, before the time.
  t.is(nextEvery({kind: 'weekly', days: [6], time: '13:00'}, local(2026, 5, 2, 12, 0)), local(2026, 5, 2, 13, 0));
  // Same day, after the time → a week later.
  t.is(nextEvery({kind: 'weekly', days: [6], time: '11:00'}, local(2026, 5, 2, 12, 0)), local(2026, 5, 9, 11, 0));
});

test('weekly across DST keeps wall time', (t) => {
  const next = nextEvery({kind: 'weekly', days: [0], time: '10:00'}, local(2026, 3, 2, 12, 0)) as number;
  t.is(next, local(2026, 3, 8, 10, 0));
  t.is(new Date(next).getHours(), 10);
});

test('firstRun for now / at / every', (t) => {
  const now = local(2026, 5, 1, 10, 0);
  t.is(firstRun({when: 'now', target: 'notify'}, now), now);
  const at = new Date(now + HOUR).toISOString();
  t.is(firstRun({when: 'at', at, target: 'notify'}, now), now + HOUR);
  t.is(
    firstRun({when: 'every', every: {kind: 'daily', time: '11:00'}, target: 'notify'}, now),
    local(2026, 5, 1, 11, 0)
  );
});

// ── cron parser ──────────────────────────────────────────────────────────

test('cron: weekday range 1-5 skips the weekend', (t) => {
  // 2026-05-01 is a Friday.
  t.is(cron('0 9 * * 1-5', local(2026, 5, 1, 10, 0)), local(2026, 5, 4, 9, 0));
  t.is(cron('0 9 * * MON-FRI', local(2026, 5, 1, 8, 0)), local(2026, 5, 1, 9, 0));
});

test('cron: steps, lists and ranges with steps', (t) => {
  t.is(cron('*/15 * * * *', local(2026, 5, 1, 10, 7)), local(2026, 5, 1, 10, 15));
  t.is(cron('5,35 * * * *', local(2026, 5, 1, 10, 7)), local(2026, 5, 1, 10, 35));
  t.is(cron('0 8-18/4 * * *', local(2026, 5, 1, 13, 0)), local(2026, 5, 1, 16, 0));
  const s = parseCron('0 0 */10 * *');
  t.deepEqual(
    [...s.dom].sort((a, b) => a - b),
    [1, 11, 21, 31],
    'dom steps start at 1, not 0'
  );
  t.deepEqual([...parseCron('10/20 * * * *').minutes], [10, 30, 50]);
});

test('cron: names, 7 = Sunday, macros', (t) => {
  const s = parseCron('0 12 * jan-MAR sun,7');
  t.deepEqual([...s.months], [1, 2, 3]);
  t.deepEqual([...s.dow], [0]);
  t.is(cron('@daily', local(2026, 5, 1, 10, 0)), local(2026, 5, 2, 0, 0));
  t.is(cron('@hourly', local(2026, 5, 1, 10, 0)), local(2026, 5, 1, 11, 0));
});

test('cron: day-of-month OR day-of-week when both are restricted', (t) => {
  // 1st/15th OR Friday. From Sat 2026-05-02: next is Fri May 8, before the 15th.
  t.is(cron('0 0 1,15 * 5', local(2026, 5, 2, 0, 0)), local(2026, 5, 8, 0, 0));
  // dow '*' → only the dom applies.
  t.is(cron('0 0 15 * *', local(2026, 5, 2, 0, 0)), local(2026, 5, 15, 0, 0));
  // dom '*' → only the dow applies (AND with a star is just the dow).
  t.is(cron('0 0 * * 5', local(2026, 5, 2, 0, 0)), local(2026, 5, 8, 0, 0));
});

test('cron: a wall time in the DST gap is skipped, not fired at the wrong hour', (t) => {
  t.is(cron('30 2 * * *', local(2026, 3, 8, 0, 0)), local(2026, 3, 9, 2, 30));
});

test('cron: rejects malformed expressions', (t) => {
  for (const bad of ['60 * * * *', '* * *', '5-1 * * * *', '*/0 * * * *', '0 0 32 * *', 'x * * * *', '1,,2 * * * *']) {
    t.throws(() => parseCron(bad), undefined, bad);
  }
});

// ── validation ───────────────────────────────────────────────────────────

const now = local(2026, 5, 1, 10, 0);
const v = (run: any) => validateRun(run as StickyRun, now);

test('validation: valid runs pass', (t) => {
  t.is(v({when: 'now', target: 'notify'}), null);
  t.is(v({when: 'at', at: new Date(now + HOUR).toISOString(), target: 'notify'}), null);
  t.is(v({when: 'every', every: {kind: 'cron', expr: '0 9 * * 1-5'}, target: 'notify'}), null);
  t.is(
    v({when: 'now', target: 'agent', agent: {provider: 'claude', image: 'default', dir: '/w', danger: false}}),
    null
  );
  t.is(v({when: 'now', target: 'pane', pane: {uid: 'abc', name: 'Naval Tern'}}), null);
});

test('validation: returns readable errors', (t) => {
  t.regex(v({when: 'soon', target: 'notify'}) as string, /When must be/);
  t.regex(v({when: 'at', target: 'notify'}) as string, /At needs/);
  t.regex(v({when: 'at', at: 'nope', target: 'notify'}) as string, /not a valid/);
  t.regex(v({when: 'at', at: new Date(now - 2 * HOUR).toISOString(), target: 'notify'}) as string, /past/);
  t.regex(v({when: 'every', target: 'notify'}) as string, /Every needs/);
  t.regex(v({when: 'every', every: {kind: 'interval', minutes: 0}, target: 'notify'}) as string, /at least 1/);
  t.regex(v({when: 'every', every: {kind: 'daily', time: '25:00'}, target: 'notify'}) as string, /HH:MM/);
  t.regex(v({when: 'every', every: {kind: 'weekly', days: [], time: '09:00'}, target: 'notify'}) as string, /weekday/);
  t.regex(v({when: 'every', every: {kind: 'cron', expr: '0 9 * *'}, target: 'notify'}) as string, /Bad cron/);
  t.regex(v({when: 'every', every: {kind: 'cron', expr: '0 0 30 2 *'}, target: 'notify'}) as string, /never fires/);
  t.regex(v({when: 'now', target: 'shell'}) as string, /Run must be/);
  t.regex(v({when: 'now', target: 'agent', agent: {provider: '', dir: '/w'}}) as string, /provider/);
  t.regex(v({when: 'now', target: 'agent', agent: {provider: 'claude', dir: ''}}) as string, /directory/);
  t.regex(v({when: 'now', target: 'pane'}) as string, /pane/);
  t.regex(v({when: 'now', target: 'notify', history: {keep: true, limit: 0}}) as string, /limit/);
});

test('approval: pane always, agent-created always, human agent runs never', (t) => {
  t.true(needsApproval({when: 'now', target: 'pane', pane: {uid: 'a', name: 'A'}, created_by: 'human'}));
  t.false(needsApproval({when: 'now', target: 'pane', pane: {uid: 'a', name: 'A'}, approved: {at: 1}}));
  t.true(needsApproval({when: 'now', target: 'notify', created_by: 'agent:latin-flea'}));
  t.false(needsApproval({when: 'now', target: 'agent', created_by: 'human'}));
});

// ── prompt builder ───────────────────────────────────────────────────────

const note: NoteData = {
  id: 'note-1-abcd',
  name: 'Weather Tokyo',
  text: 'weather in Tokyo',
  run: {when: 'every', every: {kind: 'daily', time: '08:00'}, target: 'agent', history: {keep: true, limit: 7}}
};
const rec = (finished: number, result?: string): RunRecord => ({
  note: note.id,
  run_id: `r${finished}`,
  started: finished,
  finished,
  status: 'ok',
  target: 'agent',
  result
});

test('prompt: names the sticky and the task', (t) => {
  const p = buildAgentPrompt({...note, run: {...note.run!, history: {keep: false, limit: 7}}}, [rec(1, 'x')]);
  t.true(
    p.startsWith('You\'re working on Hyperia sticky `note-1-abcd` "Weather Tokyo". Read it with sticky_note_read.')
  );
  t.true(p.includes('sticky_note_update {id, result}'));
  t.true(p.endsWith('Task: weather in Tokyo'), 'no history section when keep is off');
});

test('prompt: history newest first, empty results skipped', (t) => {
  const day = 86400000;
  const base = Date.UTC(2026, 4, 1);
  const p = buildAgentPrompt(note, [rec(base, 'rain'), rec(base + 2 * day, 'sun'), rec(base + day, '')]);
  const lines = p.split('\n');
  const i = lines.indexOf('Previous results (newest first):');
  t.true(i > 0);
  t.deepEqual(lines.slice(i + 1), ['- 2026-05-03T00:00:00.000Z: sun', '- 2026-05-01T00:00:00.000Z: rain']);
});

test('prompt: pane text is prefixed with the sticky name and id', (t) => {
  t.true(buildPanePrompt(note).startsWith('Sticky "Weather Tokyo" (note-1-abcd): You\'re working on'));
});

test('external links: only http, https and mailto reach the OS', (t) => {
  for (const ok of ['https://example.com/a', 'http://127.0.0.1:9800/x', 'mailto:a@example.com'])
    t.true(isSafeExternalUrl(ok), ok);
  for (const bad of [
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'ms-settings:',
    'smb://host/share',
    'not a url',
    42
  ]) {
    t.false(isSafeExternalUrl(bad), String(bad));
  }
});
