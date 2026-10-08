import test from 'ava';

import {sessionReplayMessages} from '../../app/utils/session-replay';

const n8 = {name: 'n8', path: 'C:\n8.exe', cmdline: 'n8 --danger', pid: 42};

test('replays shell state and cwd after a register when integration was seen', (t) => {
  t.deepEqual(
    sessionReplayMessages('p1', {integrationSeen: true, shellState: {state: 'running', app: n8}, cwd: 'C:work'}),
    [
      {type: 'SessionShellState', uid: 'p1', state: 'running', lastExit: undefined, app: n8},
      {type: 'SessionCwd', uid: 'p1', cwd: 'C:work'}
    ]
  );
});

test('a shell without integration only replays its cwd', (t) => {
  // Session's constructor defaults shellState to idle even with no integration.
  t.deepEqual(sessionReplayMessages('p1', {integrationSeen: false, shellState: {state: 'idle'}, cwd: '/w'}), [
    {type: 'SessionCwd', uid: 'p1', cwd: '/w'}
  ]);
  t.deepEqual(sessionReplayMessages('p1', {}), []);
});

test('an idle shell with integration replays idle with no app', (t) => {
  t.deepEqual(sessionReplayMessages('p1', {integrationSeen: true, shellState: {state: 'idle', lastExit: 1}}), [
    {type: 'SessionShellState', uid: 'p1', state: 'idle', lastExit: 1, app: null}
  ]);
});
