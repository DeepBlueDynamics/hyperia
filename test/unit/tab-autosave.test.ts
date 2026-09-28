/* eslint-disable eslint-comments/disable-enable-pair */
import {EventEmitter} from 'events';

import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

const fakeRpc = () => {
  const ee = new EventEmitter() as EventEmitter & {sent: any[][]};
  ee.sent = [];
  const emit = ee.emit.bind(ee);
  (ee as any).emit = (ch: string, ...args: any[]) => {
    ee.sent.push([ch, ...args]);
    return emit(ch, ...args);
  };
  return ee;
};

const load = (rpc = fakeRpc()) => ({
  rpc,
  mod: proxyquire('../../lib/utils/tab-autosave', {'../rpc': {__esModule: true, default: rpc}})
});

const layout = (cwd = '/tmp') => ({
  activeUid: 's1',
  activeRootGroup: 'root',
  activeTermGroup: 'root',
  activeSessions: {root: 's1'},
  termGroups: {
    root: {uid: 'root', parentUid: null, sessionUid: null, children: ['leafA', 'leafB']},
    leafA: {uid: 'leafA', parentUid: 'root', sessionUid: 's1', children: []},
    leafB: {uid: 'leafB', parentUid: 'root', sessionUid: 's2', children: []}
  },
  sessions: {s1: {uid: 's1', cwd}, s2: {uid: 's2', cwd: '/other'}}
});

const running = (command: string) => ({shellState: {state: 'running', command}});

test('buildAutosaveLayout keeps an approved command only while that pane still runs it', (t) => {
  const {mod} = load();
  const approved = [{sessionUid: 's1', command: 'npm run dev', source: 'shell'}];

  const still = mod.buildAutosaveLayout(layout(), {s1: running('npm run dev'), s2: {}}, 'root', approved);
  t.deepEqual(still.sessions.s1.resumeOnce, {command: 'npm run dev', source: 'shell'});

  const changed = mod.buildAutosaveLayout(layout(), {s1: running('rm -rf build'), s2: {}}, 'root', approved);
  t.is(changed.sessions.s1.resumeOnce, undefined, 'a different command is never stamped');

  const idle = mod.buildAutosaveLayout(layout(), {s1: {}, s2: running('vim x')}, 'root', approved);
  t.is(idle.sessions.s1.resumeOnce, undefined);
  t.is(idle.sessions.s2.resumeOnce, undefined, 'unapproved panes stay unstamped');
});

test('buildAutosaveLayout matches n8 resumes across the danger toggle', (t) => {
  const {mod} = load();
  const live = {s1: {n8Binding: {resume: 'n8 resume abc'}}, s2: {}};
  const approved = [{sessionUid: 's1', command: 'n8 resume --danger abc', source: 'n8'}];
  const out = mod.buildAutosaveLayout(layout(), live, 'root', approved);
  t.deepEqual(out.sessions.s1.resumeOnce, {command: 'n8 resume --danger abc', source: 'n8'});
});

test('buildAutosaveLayout returns null once the tab is gone', (t) => {
  const {mod} = load();
  t.is(mod.buildAutosaveLayout(layout(), {}, 'missing', []), null);
});

// A minimal store: getState() returns the serializer's input shape.
const fakeStore = (initial: any) => {
  let state = initial;
  const subs: Array<() => void> = [];
  return {
    getState: () => state,
    subscribe: (fn: () => void) => {
      subs.push(fn);
      return () => subs.splice(subs.indexOf(fn), 1);
    },
    set(next: any) {
      state = next;
      subs.forEach((f) => f());
    }
  };
};

const hyperState = (cwd: string, extraRoot = false) => {
  const l = layout(cwd);
  const termGroups: any = {...l.termGroups};
  if (extraRoot) termGroups.other = {uid: 'other', parentUid: null, sessionUid: null, children: []};
  const wrap = (o: any) => ({...o, asMutable: () => o});
  return {
    termGroups: {
      termGroups: Object.fromEntries(
        Object.entries(termGroups).map(([k, g]: [string, any]) => [k, {...g, children: wrap(g.children)}])
      ),
      activeRootGroup: 'root',
      activeTermGroup: 'root',
      activeSessions: wrap({root: 's1'})
    },
    sessions: {activeUid: 's1', sessions: l.sessions}
  };
};

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.serial('engine re-saves a bound tab after changes settle, and skips identical snapshots', async (t) => {
  const {mod, rpc} = load();
  const store = fakeStore(hyperState('/a'));
  const stop = mod.startTabAutosave(store, () => undefined, 20);
  t.teardown(stop);

  store.set(hyperState('/b'));
  await tick(60);
  t.is(rpc.sent.length, 0, 'nothing bound, nothing saved');

  mod.setTabAutosave('root', {name: 'Dev', approved: []});
  store.set(hyperState('/c'));
  store.set(hyperState('/d'));
  await tick(60);
  const saves = rpc.sent.filter(([ch]) => ch === 'save tab workspace');
  t.is(saves.length, 1, 'debounced into one save');
  t.like(saves[0][1], {name: 'Dev', overwrite: true, autosave: true});
  t.is(saves[0][1].layout.sessions.s1.cwd, '/d');

  // A change elsewhere that leaves this tab's snapshot identical: no write.
  store.set(hyperState('/d', true));
  await tick(60);
  t.is(rpc.sent.filter(([ch]) => ch === 'save tab workspace').length, 1);
});

test.serial('engine drops the binding when the tab closes, and retries after a failed write', async (t) => {
  const {mod, rpc} = load();
  const store = fakeStore(hyperState('/a'));
  const stop = mod.startTabAutosave(store, () => undefined, 20);
  t.teardown(stop);
  mod.setTabAutosave('root', {name: 'Dev', approved: []});

  store.set(hyperState('/b'));
  await tick(60);
  rpc.emit('save tab workspace result', {ok: false, name: 'Dev', error: 'boom', autosave: true});
  t.is(mod.getTabAutosave('root').lastSaved, undefined, 'failure forgets the snapshot');

  const gone = hyperState('/b');
  delete (gone.termGroups.termGroups as any).root;
  store.set(gone);
  await tick(60);
  t.is(mod.getTabAutosave('root'), undefined);
});

test.serial('engine announces a landed autosave for its tab, and only then', async (t) => {
  const g = globalThis as any;
  const hadWindow = 'window' in g;
  g.window = new EventTarget();
  t.teardown(() => {
    if (!hadWindow) delete g.window;
  });
  const seen: string[] = [];
  g.window.addEventListener('hyperia-tab-autosaved', (e: any) => seen.push(e.detail.rootUid));

  const {mod, rpc} = load();
  t.is(mod.TAB_AUTOSAVED_EVENT, 'hyperia-tab-autosaved');
  const store = fakeStore(hyperState('/a'));
  const stop = mod.startTabAutosave(store, () => undefined, 20);
  t.teardown(stop);
  mod.setTabAutosave('root', {name: 'Dev', approved: []});

  store.set(hyperState('/b'));
  await tick(60);
  t.deepEqual(seen, [], 'nothing until the write is confirmed');

  rpc.emit('save tab workspace result', {ok: true, name: 'Dev'});
  t.deepEqual(seen, [], 'a manual (non-autosave) save result is not ours');

  rpc.emit('save tab workspace result', {ok: false, name: 'Dev', error: 'x', autosave: true});
  t.deepEqual(seen, [], 'a failed write does not pulse');

  store.set(hyperState('/c'));
  await tick(60);
  rpc.emit('save tab workspace result', {ok: true, name: 'Dev', autosave: true});
  t.deepEqual(seen, ['root']);
});

// State whose only change is s1's title (what an agent's spinner does).
const titled = (cwd: string, title: string) => {
  const st: any = hyperState(cwd);
  st.sessions.sessions = {...st.sessions.sessions, s1: {...st.sessions.sessions.s1, title}};
  return st;
};

test.serial('title churn alone never writes, and the max wait still saves a real change under churn', async (t) => {
  const {mod, rpc} = load();
  const store = fakeStore(hyperState('/a'));
  const stop = mod.startTabAutosave(store, () => undefined, 30, 120);
  t.teardown(stop);
  mod.setTabAutosave('root', {name: 'Busy', approved: []});
  const saves = () => rpc.sent.filter(([ch]) => ch === 'save tab workspace');

  // First settle writes the baseline.
  store.set(hyperState('/a'));
  await tick(80);
  const base = saves().length;

  // Titles only, fast enough to keep restarting the debounce: nothing to write.
  for (let i = 0; i < 12; i++) {
    store.set(titled('/a', `⠋ working ${i}`));
    await tick(15);
  }
  await tick(80);
  t.is(saves().length, base, 'no write for title-only changes');

  // A real change (cwd) during continuous churn still saves within the max wait.
  store.set(titled('/b', 'x'));
  const t0 = Date.now();
  while (Date.now() - t0 < 400 && saves().length === base) {
    store.set(titled('/b', `⠙ ${Date.now()}`));
    await tick(15);
  }
  t.is(saves().length, base + 1, 'saved despite churn');
  t.is(saves()[base][1].layout.sessions.s1.cwd, '/b');
});

test.serial('one tab per saved name, deleted names end their bindings, restore re-binds', (t) => {
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => (store[k] = v)
  };
  t.teardown(() => delete (globalThis as any).localStorage);
  const {mod, rpc} = load();
  const stop = mod.startTabAutosave(fakeStore(hyperState('/a')), () => undefined, 20);
  t.teardown(stop);

  mod.setTabAutosave('tabA', {name: 'Dev', approved: []});
  mod.setTabAutosave('tabB', {name: 'Dev', approved: []});
  t.is(mod.getTabAutosave('tabA'), undefined, 'older tab loses the name');
  t.is(mod.getTabAutosave('tabB')?.name, 'Dev');
  t.true(mod.isAutosaveName('Dev'));

  // Restoring the saved tab re-binds the new root with its approved resumes.
  const saved = {
    termGroups: {r: {uid: 'r', parentUid: null}},
    sessions: {s9: {resumeOnce: {command: 'n8 resume x', source: 'n8'}}}
  };
  t.true(mod.bindRestoredTab('restored', 'Dev', saved));
  t.deepEqual(mod.getTabAutosave('restored')?.approved, [{sessionUid: 's9', command: 'n8 resume x', source: 'n8'}]);
  t.false(mod.bindRestoredTab('other', 'NotAutosaved', saved));

  // The library comes back without "Dev": it was deleted.
  rpc.emit('tab workspaces list', {rows: [{name: 'Else'}]});
  t.is(mod.getTabAutosave('restored'), undefined);
  t.false(mod.isAutosaveName('Dev'));
});

test('autosaveSignature ignores titles, focus, sizes and pids but not cwd, splits or resumes', (t) => {
  const {mod} = load();
  const a: any = layout('/a');
  const noisy = JSON.parse(JSON.stringify(a));
  noisy.activeUid = 's2';
  noisy.sessions.s1 = {...noisy.sessions.s1, title: 'spin', cols: 99, rows: 9, pid: 42};
  t.is(mod.autosaveSignature(noisy), mod.autosaveSignature(a));
  t.not(mod.autosaveSignature(layout('/b')), mod.autosaveSignature(a));
  const resumed = JSON.parse(JSON.stringify(a));
  resumed.sessions.s1.resumeOnce = {command: 'npm run dev', source: 'shell'};
  t.not(mod.autosaveSignature(resumed), mod.autosaveSignature(a));
});
