/* eslint-disable eslint-comments/disable-enable-pair */

import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

// app/workspace.ts imports electron for geometry capture; the pure layout
// normalizer under test never touches it.
const {toWorkspaceLayout} = proxyquire('../../app/workspace', {
  electron: {screen: {getDisplayMatching: () => ({id: 1})}}
});

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
