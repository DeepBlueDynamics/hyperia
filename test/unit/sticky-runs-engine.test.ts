/* eslint-disable eslint-comments/disable-enable-pair */

// Engine behaviour through the sticky facade: catch-up, overlap, pane-missing, n8 missing, atomic writer.
import {existsSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import test from 'ava';
import type {ExecutionContext} from 'ava';

import {createStickyFixture} from '../helpers/sticky-main-fixture';
import type {FakeBrowserWindow, StickyFixture} from '../helpers/sticky-main-fixture';

type Route = (method: string, path: string, body: any) => {status: number; body: unknown} | undefined;

/** Stub global fetch (the sidecar client) for one test; unmatched routes 404. */
function mockSidecar(t: ExecutionContext, route: Route) {
  const calls: Array<{method: string; path: string; body: any}> = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({method, path, body});
    const r = route(method, path, body) || {status: 404, body: {error: 'no route'}};
    return Promise.resolve(
      new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {status: r.status})
    );
  };
  t.teardown(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function readNotes(f: StickyFixture): any[] {
  return JSON.parse(readFileSync(f.notesFile, 'utf8'));
}

function seed(f: StickyFixture, notes: any[]) {
  writeFileSync(f.notesFile, JSON.stringify(notes));
}

function history(f: StickyFixture): any[] {
  const file = join(f.stickysDir, 'runs.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const MIN = 60000;

test.serial('catch-up: a missed Every fires once on launch, then re-arms from now', async (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  const now = Date.now();
  seed(f, [
    {
      id: 'n1',
      name: 'Hourly',
      text: 'stretch',
      run: {when: 'every', every: {kind: 'interval', minutes: 60}, target: 'notify', created_by: 'human'},
      run_state: {next_run: now - 3 * 60 * MIN}
    }
  ]);
  f.sticky.initSticky();
  await f.triggerSchedulerTick();
  t.is(f.notifications.length, 1, 'three missed hours → one catch-up run');
  const st = readNotes(f)[0].run_state;
  t.is(st.last_status, 'ok');
  t.true(st.next_run > Date.now() + 59 * MIN && st.next_run <= Date.now() + 60 * MIN);
  await f.triggerSchedulerTick();
  t.is(f.notifications.length, 1, 'no second fire before next_run');
  t.is(history(f).length, 1);
  t.is(history(f)[0].status, 'ok');
});

test.serial('At in the past runs once on launch and is then done', async (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  const past = new Date(Date.now() - 2 * 60 * MIN).toISOString();
  seed(f, [
    {id: 'n1', text: 'x', run: {when: 'at', at: past, target: 'notify'}, run_state: {next_run: Date.parse(past)}}
  ]);
  f.sticky.initSticky();
  await f.triggerSchedulerTick();
  await f.triggerSchedulerTick();
  t.is(f.notifications.length, 1);
  const n = readNotes(f)[0];
  t.is(n.run, null, 'one-shot cleared after it finished');
  t.is(n.run_state.last_status, 'ok');
  t.is(n.run_state.next_run, undefined);
});

test.serial('setRun validates and returns errors; legacy schedule is dropped on write', (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  seed(f, [{id: 'n1', text: 'x', schedule: {when: 'cron', runner: 'shell', cron: '* * * * *'}}]);
  f.sticky.initSticky();
  const bad = f.sticky.setRun('n1', {when: 'every', every: {kind: 'cron', expr: '0 9 * *'}, target: 'notify'});
  t.false(bad.ok);
  t.regex((bad as any).error, /cron/);
  const ok = f.sticky.setRun('n1', {when: 'every', every: {kind: 'cron', expr: '0 9 * * 1-5'}, target: 'notify'});
  t.true(ok.ok);
  t.is((ok as any).status, 'scheduled');
  t.true((ok as any).next_run > Date.now());
  const n = readNotes(f)[0];
  t.false('schedule' in n);
  t.is(n.run_state.next_run, (ok as any).next_run);
});

test.serial('IPC sticky-run-set marks the run human-approved; bridge-style pane runs await approval', async (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  seed(f, [{id: 'n1', text: 'x'}]);
  f.sticky.initSticky();
  const pane = {uid: 'p1', name: 'Naval Tern'};
  const pending = f.sticky.setRun('n1', {when: 'every', every: {kind: 'interval', minutes: 5}, target: 'pane', pane});
  t.is((pending as any).status, 'awaiting_approval');
  t.is(readNotes(f)[0].run_state.last_status, 'awaiting_approval');
  const res = await f.ipcInvoke('sticky-run-set', {}, 'n1', {
    when: 'every',
    every: {kind: 'interval', minutes: 5},
    target: 'pane',
    pane
  });
  t.is(res.status, 'scheduled');
  const run = readNotes(f)[0].run;
  t.is(run.created_by, 'human');
  t.is(typeof run.approved.at, 'number');
});

test.serial('pane missing: Every pauses itself with a footer reason', async (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  const calls = mockSidecar(t, (m, p) =>
    p === '/api/status'
      ? {status: 200, body: {windows: [{id: 1, tabs: [{name: 'T', panes: [{paneId: 'other', name: 'Other'}]}]}]}}
      : undefined
  );
  seed(f, [
    {
      id: 'n1',
      text: 'ping',
      run: {
        when: 'every',
        every: {kind: 'interval', minutes: 5},
        target: 'pane',
        pane: {uid: 'gone', name: 'Naval Tern'},
        approved: {at: 1}
      },
      run_state: {next_run: Date.now() - 1000}
    }
  ]);
  f.sticky.initSticky();
  await f.triggerSchedulerTick();
  const n = readNotes(f)[0];
  t.is(n.run.paused, true);
  t.is(n.run_state.last_status, 'halted');
  t.is(n.run_state.last_error, 'Pane Naval Tern closed; schedule paused');
  t.falsy(
    calls.find((c) => c.path === '/api/pane/send'),
    'nothing sent'
  );
});

test.serial('pane missing: a Now run halts and is done; a present pane gets the prefixed text', async (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  const calls = mockSidecar(t, (m, p) => {
    if (p === '/api/status') {
      return {status: 200, body: {windows: [{id: 1, tabs: [{name: 'T', panes: [{paneId: 'here', name: 'Here'}]}]}]}};
    }
    if (p === '/api/pane/send') return {status: 202, body: {ok: true}};
    return undefined;
  });
  seed(f, [
    {id: 'gone1', name: 'G', text: 'a'},
    {id: 'here1', name: 'Weather', text: 'weather in Tokyo'}
  ]);
  f.sticky.initSticky();
  await f.ipcInvoke('sticky-run-set', {}, 'gone1', {when: 'now', target: 'pane', pane: {uid: 'gone', name: 'Gone'}});
  await f.ipcInvoke('sticky-run-set', {}, 'here1', {when: 'now', target: 'pane', pane: {uid: 'here', name: 'Here'}});
  await settle();
  const [gone, here] = readNotes(f);
  t.is(gone.run, null);
  t.is(gone.run_state.last_status, 'halted');
  t.is(gone.run_state.last_error, 'Pane Gone is closed');
  t.is(here.run_state.last_status, 'ok');
  const send = calls.find((c) => c.path === '/api/pane/send');
  t.is(send?.body.pane, 'here');
  t.true(send?.body.text.startsWith('Sticky "Weather" (here1): '));
  t.true(send?.body.submit);
});

test.serial('non-2xx from the sidecar is a failed run with the body as the error', async (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  mockSidecar(t, (m, p) => {
    if (p === '/api/status') return {status: 200, body: {windows: [{id: 1, tabs: [{panes: [{paneId: 'here'}]}]}]}};
    if (p === '/api/pane/send') return {status: 409, body: {error: 'Pane is a shell prompt.'}};
    return undefined;
  });
  seed(f, [{id: 'n1', text: 'a'}]);
  f.sticky.initSticky();
  await f.ipcInvoke('sticky-run-set', {}, 'n1', {when: 'now', target: 'pane', pane: {uid: 'here', name: 'H'}});
  await settle();
  const st = readNotes(f)[0].run_state;
  t.is(st.last_status, 'failed');
  t.is(st.last_error, 'HTTP 409: Pane is a shell prompt.');
});

test.serial('agent: n8 not installed halts and appends a notice to the result', async (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  mockSidecar(t, (m, p) =>
    p === '/api/n8/status' ? {status: 200, body: {installed: false, running: false}} : undefined
  );
  seed(f, [{id: 'n1', text: 'weather', result: 'old result'}]);
  f.sticky.initSticky();
  const agent = {provider: 'claude', image: 'default', dir: '/w', danger: false};
  await f.ipcInvoke('sticky-run-set', {}, 'n1', {when: 'now', target: 'agent', agent});
  await settle();
  const n = readNotes(f)[0];
  t.is(n.run_state.last_status, 'halted');
  t.regex(n.run_state.last_error, /isn't installed/);
  t.true(n.result.startsWith("old result\n\n> nemesis8 isn't installed. See Config → nemesis8 ("));
  t.true(n.result.includes('https://nemesis8.nuts.services'));
  t.is(n.text, 'weather', 'the prompt is never touched');
});

test.serial('agent: starts n8, creates a trigger with the prompt, and polls until it resolves', async (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  let polls = 0;
  const calls = mockSidecar(t, (m, p) => {
    if (p === '/api/n8/status') return {status: 200, body: {installed: true, running: false}};
    if (p === '/api/n8/start') return {status: 200, body: {ok: true, running: true}};
    if (p === '/api/n8/run' && m === 'POST') return {status: 200, body: {ok: true, trigger_id: 'trig1'}};
    if (p === '/api/n8/run/trig1' && m === 'GET') {
      polls++;
      return {status: 200, body: polls < 2 ? {last_fired: null} : {last_fired: 'x', last_status: 'ok'}};
    }
    if (p === '/api/n8/run/trig1' && m === 'DELETE') return {status: 200, body: {ok: true}};
    return undefined;
  });
  seed(f, [{id: 'n1', name: 'W', text: 'weather'}]);
  f.sticky.initSticky();
  // Collapse the 5 s poll sleep (the fixture restores setTimeout on teardown).
  (global as any).setTimeout = (fn: () => void) => setImmediate(fn);
  const agent = {provider: 'claude', image: 'default', dir: '/w', danger: true};
  await f.ipcInvoke('sticky-run-set', {}, 'n1', {when: 'now', target: 'agent', agent});
  await settle(80);
  const run = calls.find((c) => c.path === '/api/n8/run' && c.method === 'POST');
  t.is(run?.body.provider, 'claude');
  t.true(run?.body.danger);
  t.true(run?.body.prompt.includes('Task: weather'));
  t.truthy(calls.find((c) => c.path === '/api/n8/start'));
  t.is(polls, 2);
  t.truthy(
    calls.find((c) => c.path === '/api/n8/run/trig1' && c.method === 'DELETE'),
    'trigger cleaned up'
  );
  const n = readNotes(f)[0];
  t.is(n.run_state.last_status, 'ok');
  t.is(n.run_state.trigger_id, undefined);
  t.is(n.run, null, 'Now is done once it finished');
  t.is(n.result, undefined, 'stdout is never written into the result');
});

test.serial('overlap: a fire while the previous run is in flight is skipped and recorded', async (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  mockSidecar(t, (m, p) => {
    if (p === '/api/n8/status') return {status: 200, body: {installed: true, running: true}};
    if (p === '/api/n8/run' && m === 'POST') return {status: 200, body: {trigger_id: 'slow'}};
    return {status: 200, body: {last_fired: null}};
  });
  const agent = {provider: 'claude', image: 'default', dir: '/w', danger: false};
  seed(f, [
    {
      id: 'n1',
      text: 'x',
      run: {when: 'every', every: {kind: 'interval', minutes: 1}, target: 'agent', agent},
      run_state: {next_run: Date.now() - 1000}
    }
  ]);
  f.sticky.initSticky();
  // First tick starts the agent run; its poll sleep never resolves, so it stays in flight.
  void f.triggerSchedulerTick();
  await settle();
  t.is(readNotes(f)[0].run_state.last_status, 'running');
  const notes = readNotes(f);
  notes[0].run_state.next_run = Date.now() - 1000;
  seed(f, notes);
  await f.triggerSchedulerTick();
  const h = history(f);
  t.is(h.length, 1);
  t.is(h[0].status, 'skipped');
  const st = readNotes(f)[0].run_state;
  t.is(st.last_status, 'running', 'the in-flight run keeps its status');
  t.true(st.next_run > Date.now(), 'the clock still advances');
  const now = await f.ipcInvoke('sticky-run-now', {}, 'n1');
  t.false(now.ok, 'run-now refuses while a run is in flight');
});

test.serial('pause/resume: paused runs never fire; resume recomputes next_run', async (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  seed(f, [{id: 'n1', text: 'x'}]);
  f.sticky.initSticky();
  await f.ipcInvoke('sticky-run-set', {}, 'n1', {
    when: 'every',
    every: {kind: 'interval', minutes: 1},
    target: 'notify'
  });
  const p = await f.ipcInvoke('sticky-run-pause', {}, 'n1', true);
  t.true(p.ok);
  const notes = readNotes(f);
  notes[0].run_state.next_run = Date.now() - 1000;
  seed(f, notes);
  await f.triggerSchedulerTick();
  t.is(f.notifications.length, 0);
  const r = await f.ipcInvoke('sticky-run-pause', {}, 'n1', false);
  t.true(r.next_run > Date.now());
  t.false(readNotes(f)[0].run.paused);
});

test.serial('armed state is re-sent when a sticky window is created (survives restart)', (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  seed(f, [
    {
      id: 'n1',
      text: 'x',
      run: {when: 'every', every: {kind: 'daily', time: '08:00'}, target: 'notify'},
      run_state: {next_run: Date.now() + 1000}
    }
  ]);
  f.sticky.initSticky();
  const res = f.sticky.createStickyNote({id: 'n1'});
  const win = res.win as FakeBrowserWindow;
  win.emit('ready-to-show');
  const sent = win.webContents.sent.find((s) => s.channel === 'sticky-run-state');
  t.truthy(sent);
  t.is(sent!.args[1].when, 'every');
  t.is(typeof sent!.args[0].next_run, 'number');
});

test.serial('atomic writer: a corrupt notes.json is never overwritten', (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  seed(f, [{id: 'n1', text: 'x'}]);
  f.sticky.initSticky();
  const torn = '[{"id":"n1","text":"x"},{"id":"n2"';
  writeFileSync(f.notesFile, torn);
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    t.false(f.sticky.setResult('n1', 'hello'));
    t.is(f.sticky.setRunState('n1', {last_status: 'ok'}), undefined);
    f.sticky.createStickyNote({text: 'new note'});
    t.false(f.sticky.setRun('n1', {when: 'now', target: 'notify'}).ok);
  } finally {
    console.error = origError;
  }
  t.is(readFileSync(f.notesFile, 'utf8'), torn, 'file untouched');
  t.true(errors.some((e) => String((e as unknown[])[0]).includes('refusing to write')));
});

test.serial('history: trimmed per note to history.limit, results snapshotted when kept', async (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  seed(f, [
    {id: 'n1', text: 'x', result: 'R'},
    {id: 'n2', text: 'y'}
  ]);
  f.sticky.initSticky();
  for (let i = 0; i < 4; i++) {
    await f.ipcInvoke('sticky-run-set', {}, 'n1', {when: 'now', target: 'notify', history: {keep: true, limit: 2}});
    await settle();
  }
  await f.ipcInvoke('sticky-run-set', {}, 'n2', {when: 'now', target: 'notify'});
  await settle();
  const h = history(f);
  t.is(h.filter((r) => r.note === 'n1').length, 2);
  t.is(h.filter((r) => r.note === 'n2').length, 1);
  t.is(h.find((r) => r.note === 'n1').result, 'R');
  t.is(h.find((r) => r.note === 'n2').result, undefined);
  const viaIpc = await f.ipcInvoke('sticky-run-history', {}, 'n1', 10);
  t.is(viaIpc.length, 2);
  t.true(viaIpc[0].finished >= viaIpc[1].finished);
});

test.serial('bridge-style pause: re-sending the stored run with paused flips only the pause', (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  const past = new Date(Date.now() - 5 * MIN).toISOString();
  const run = {when: 'at', at: past, target: 'notify', created_by: 'human', approved: {at: 1}};
  seed(f, [{id: 'n1', text: 'x', run, run_state: {next_run: Date.parse(past)}}]);
  f.sticky.initSticky();
  const paused = f.sticky.setRun('n1', {...run, paused: true} as any);
  t.deepEqual(paused, {ok: true, next_run: undefined, status: 'paused'});
  t.true(readNotes(f)[0].run.paused);
  const resumed = f.sticky.setRun('n1', {...run, paused: false} as any);
  t.true(resumed.ok, 'a past At resumes without failing validation');
  t.is((resumed as any).status, 'scheduled');
});
