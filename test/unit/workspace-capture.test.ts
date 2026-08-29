/* eslint-disable eslint-comments/disable-enable-pair */

import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

// app/workspace.ts imports electron for geometry capture; the pure layout
// normalizer under test never touches it.
// Load app/workspace with its electron/sticky/window-state seams stubbed.
const loadWorkspaceModule = (overrides: Record<string, any> = {}) =>
  proxyquire('../../app/workspace', {
    electron: {app: {}, screen: {getDisplayMatching: () => ({id: 1}), getAllDisplays: () => []}},
    './window-state': {boundsAreVisible: () => true},
    './sticky': {
      listOpenStickyRefs: () => [],
      readAllNotes: () => [],
      createStickyNote: () => ({win: null, id: '', name: ''})
    },
    ...overrides
  });

const {toWorkspaceLayout, remapUids, annotateMissingResources} = loadWorkspaceModule();

test('toWorkspaceLayout strips the transport envelope and pids', (t) => {
  const layout = toWorkspaceLayout({
    requestId: 'abc123',
    activeUid: 's1',
    activeRootGroup: 'g1',
    termGroups: {g1: {uid: 'g1'}},
    sessions: {
      s1: {uid: 's1', cwd: '/home/x', pid: 4242, annotations: {lastCommand: 'vim .'}}
    }
  });
  t.is(layout.requestId, undefined);
  t.is(layout.activeUid, 's1');
  t.is(layout.sessions.s1.pid, undefined);
  t.is(layout.sessions.s1.cwd, '/home/x');
  t.deepEqual(layout.sessions.s1.annotations, {lastCommand: 'vim .'});
});

test('toWorkspaceLayout folds a legacy bare lastCommand into annotations', (t) => {
  const layout = toWorkspaceLayout({
    sessions: {s1: {uid: 's1', lastCommand: 'make test', pid: 7}}
  });
  t.is(layout.sessions.s1.lastCommand, undefined);
  t.deepEqual(layout.sessions.s1.annotations, {lastCommand: 'make test'});
});

test('toWorkspaceLayout leaves sessions without a command annotation-free', (t) => {
  const layout = toWorkspaceLayout({
    sessions: {s1: {uid: 's1', cwd: '/tmp'}}
  });
  t.is(layout.sessions.s1.annotations, undefined);
  t.deepEqual(layout.sessions.s1, {uid: 's1', cwd: '/tmp'});
});

// ---- remapUids (#168) ------------------------------------------------------

const sampleLayout = () => ({
  activeUid: 's1',
  activeRootGroup: 'root',
  activeTermGroup: 'leafA',
  activeSessions: {root: 's1'},
  termGroups: {
    root: {uid: 'root', sessionUid: null, parentUid: null, direction: 'VERTICAL', children: ['leafA', 'leafB']},
    leafA: {uid: 'leafA', sessionUid: 's1', parentUid: 'root', direction: null, children: []},
    leafB: {uid: 'leafB', sessionUid: null, parentUid: 'root', direction: null, children: [], webUrl: 'https://x'}
  },
  sessions: {s1: {uid: 's1', cwd: '/tmp', profile: 'zsh'}}
});

test('remapUids preserves structure while replacing every uid', (t) => {
  let n = 0;
  const layout = remapUids(sampleLayout(), () => `new-${n++}`);

  const oldUids = ['root', 'leafA', 'leafB', 's1'];
  const dump = JSON.stringify(layout);
  for (const old of oldUids) {
    t.false(new RegExp(`"${old}"`).test(dump), `old uid ${old} must not survive`);
  }

  // Structure holds under the new names.
  const rootUid = layout.activeRootGroup;
  const root = layout.termGroups[rootUid];
  t.is(root.children.length, 2);
  const [a, b] = root.children.map((c: string) => layout.termGroups[c]);
  t.is(a.parentUid, rootUid);
  t.is(b.parentUid, rootUid);
  t.is(b.webUrl, 'https://x');
  // Session linkage: leafA's sessionUid names a real session, and the active
  // pointers agree.
  t.truthy(layout.sessions[a.sessionUid]);
  t.is(layout.sessions[a.sessionUid].uid, a.sessionUid);
  t.is(layout.activeUid, a.sessionUid);
  t.is(layout.activeSessions[rootUid], a.sessionUid);
  t.is(layout.activeTermGroup, root.children[0]);
});

test('remapUids twice yields disjoint uid sets (collision-proof)', (t) => {
  const first = remapUids(sampleLayout());
  const second = remapUids(sampleLayout());
  const uids = (l: any) => new Set([...Object.keys(l.termGroups), ...Object.keys(l.sessions)]);
  for (const uid of uids(first)) {
    t.false(uids(second).has(uid));
  }
});

// ---- sticky restore (#170) -------------------------------------------------

test('restoreWorkspace reopens existing stickys and skips deleted ones', (t) => {
  const created: any[] = [];
  const opened: any[] = [];
  const mod = loadWorkspaceModule({
    electron: {
      app: {
        createWindow: (fn: any) => {
          created.push(fn);
          return {setFullScreen: () => {}, maximize: () => {}};
        }
      },
      screen: {getDisplayMatching: () => ({id: 1}), getAllDisplays: () => []}
    },
    './sticky': {
      listOpenStickyRefs: () => [],
      readAllNotes: () => [{id: 'note-alive'}],
      createStickyNote: (opts: any) => {
        opened.push(opts);
        return {win: {}, id: opts.id, name: 'x'};
      }
    }
  });
  const summary = mod.restoreWorkspace({
    windows: [{geometry: {x: 0, y: 0, width: 800, height: 600}, layout: {termGroups: {}, sessions: {}}}],
    stickys: [
      {id: 'note-alive', x: 11, y: 22, width: 300, height: 200, open: true},
      {id: 'note-gone', x: 1, y: 2, width: 300, height: 200, open: true}
    ]
  });
  t.is(summary.created, 1);
  t.is(summary.stickysReopened, 1);
  t.deepEqual(summary.stickysSkipped, ['note-gone']);
  t.is(opened.length, 1);
  t.deepEqual(opened[0], {id: 'note-alive', x: 11, y: 22, width: 300, height: 200});
});

// ---- annotateMissingResources (#168) --------------------------------------

test('annotateMissingResources marks only sessions whose cwd is gone', (t) => {
  const {layout, notices} = annotateMissingResources(
    {
      sessions: {
        ok: {uid: 'ok', cwd: '/exists'},
        gone: {uid: 'gone', cwd: '/vanished'},
        none: {uid: 'none'}
      }
    },
    (cwd: string) => cwd === '/exists'
  );
  t.is(layout.sessions.ok.restoreNotice, undefined);
  t.is(layout.sessions.none.restoreNotice, undefined);
  t.true(layout.sessions.gone.restoreNotice.includes('/vanished'));
  t.is(notices.length, 1);
});
