/* eslint-disable @typescript-eslint/no-var-requires */
import test from 'ava';

import type Session from '../../app/session';

const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const SessionClass = proxyquire('../../app/session', {
  electron: {},
  'node-pty': {spawn: () => {}},
  'default-shell': 'bash',
  'os-locale': {},
  'shell-env': {},
  './config': {getConfig: () => ({})},
  './plugins': {},
  './utils/shell-fallback': {}
}).default as typeof Session;
/* eslint-enable @typescript-eslint/no-var-requires */

function fixture() {
  const calls: number[][] = [];
  const pty = {
    cols: 120,
    rows: 40,
    resize(cols: number, rows: number) {
      calls.push([cols, rows]);
      this.cols = cols;
      this.rows = rows;
    }
  };
  const session = Object.create(SessionClass.prototype) as Session;
  Object.assign(session, {pty, ended: false, shellState: {state: 'idle'}});
  return {session, pty, calls};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 90));

test('first resize uses spawn dimensions and records intermediate size', async (t) => {
  const {session, calls} = fixture();
  session.resize({cols: 60, rows: 20});
  t.deepEqual(calls, [[60, 40]]);
  t.deepEqual(session.lastResize, {cols: 60, rows: 40});
  await settle();
  t.deepEqual(calls, [
    [60, 40],
    [60, 20]
  ]);
  t.deepEqual(session.lastResize, {cols: 60, rows: 20});
});

test('a newer height supersedes the delayed height without reverting', async (t) => {
  const {session, pty, calls} = fixture();
  session.resize({cols: 60, rows: 20});
  session.resize({cols: 60, rows: 15});
  await settle();
  t.deepEqual(calls, [
    [60, 40],
    [60, 15]
  ]);
  t.is(pty.rows, 15);
});

test('overlapping two-axis resizes use the intermediate height', async (t) => {
  const {session, calls} = fixture();
  session.resize({cols: 60, rows: 20});
  session.resize({cols: 50, rows: 15});
  await settle();
  t.deepEqual(calls, [
    [60, 40],
    [50, 40],
    [50, 15]
  ]);
});

test('returning to the current size cancels the pending height', async (t) => {
  const {session, calls} = fixture();
  session.resize({cols: 60, rows: 20});
  session.resize({cols: 60, rows: 40});
  await settle();
  t.deepEqual(calls, [[60, 40]]);
});

test('running apps resize atomically and supersede idle-shell timers', async (t) => {
  const {session, calls} = fixture();
  session.resize({cols: 60, rows: 20});
  session.shellState = {state: 'running'};
  session.resize({cols: 50, rows: 15});
  await settle();
  t.deepEqual(calls, [
    [60, 40],
    [50, 15]
  ]);
});

test('closing a session prevents its delayed resize', async (t) => {
  const {session, calls} = fixture();
  session.resize({cols: 60, rows: 20});
  session.ended = true;
  await settle();
  t.deepEqual(calls, [[60, 40]]);
});

test('replacement PTY neither receives old timer nor inherits old dimensions', async (t) => {
  const {session, calls} = fixture();
  const replacement = fixture();
  session.resize({cols: 60, rows: 20});
  session.pty = replacement.session.pty;
  await settle();
  t.deepEqual(calls, [[60, 40]]);
  t.deepEqual(replacement.calls, []);
  session.resize({cols: 60, rows: 20});
  await settle();
  t.deepEqual(replacement.calls, [
    [60, 40],
    [60, 20]
  ]);
});

test('startup-queued node-pty calls retain their accepted dimensions', async (t) => {
  const {session, pty, calls} = fixture();
  pty.resize = (cols, rows) => {
    calls.push([cols, rows]);
  };
  session.resize({cols: 60, rows: 20});
  session.resize({cols: 120, rows: 40});
  await settle();
  t.deepEqual(calls, [
    [60, 40],
    [120, 40]
  ]);
});
