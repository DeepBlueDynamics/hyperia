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
