import test from 'ava';

import {cloneLaunchFor, describeCloneLaunch, isAgentProfile} from '../../lib/utils/clone-launch';

test('no session or a picker pane clones to a picker', (t) => {
  t.deepEqual(cloneLaunchFor(undefined), {profile: 'picker', cwd: undefined});
  t.deepEqual(cloneLaunchFor({profile: 'picker', cwd: '/w'}), {profile: 'picker', cwd: '/w'});
});

test('an idle shell clones to the same shell in the same cwd, no command', (t) => {
  const s = {profile: 'pwsh', cwd: '/proj', shellState: {state: 'idle', command: 'ls'}};
  t.deepEqual(cloneLaunchFor(s), {profile: 'pwsh', cwd: '/proj'});
});

test('a shell running a program re-runs its reported command', (t) => {
  const s = {profile: 'pwsh', cwd: '/proj', shellState: {state: 'running', command: 'n8 --danger'}};
  t.deepEqual(cloneLaunchFor(s), {profile: 'pwsh', cwd: '/proj', command: 'n8 --danger'});
});

test('Term busy flag and app cmdline count too', (t) => {
  const s = {profile: 'bash', busy: true, shellState: {state: 'idle', app: {cmdline: 'vim notes.md'}}};
  t.is(cloneLaunchFor(s).command, 'vim notes.md');
});

test('the screen-scraped lastCommand is never executed', (t) => {
  const s = {profile: 'bash', lastCommand: 'rm -rf build', busy: true};
  t.is(cloneLaunchFor(s).command, undefined);
});

test('n8Binding.resume is not reused (clones get a fresh session)', (t) => {
  const s = {profile: 'bash', n8Binding: {kind: 'n8', sessionId: 'x', workspace: 'w', resume: 'n8 resume x'}};
  t.is(cloneLaunchFor(s).command, undefined);
});

test('agent profiles clone by profile alone (the profile IS the program)', (t) => {
  const s = {profile: 'Claude Code', cwd: '/p', busy: true, shellState: {state: 'running', command: 'claude'}};
  t.deepEqual(cloneLaunchFor(s), {profile: 'Claude Code', cwd: '/p'});
  const custom = {profile: 'my-agent', busy: true, shellState: {state: 'running', command: 'x'}};
  t.deepEqual(cloneLaunchFor(custom, [{name: 'my-agent', kind: 'agent'}]), {profile: 'my-agent', cwd: undefined});
});

test('isAgentProfile matches built-in names and kind:agent profiles', (t) => {
  t.true(isAgentProfile('nemesis8 danger'));
  t.true(isAgentProfile('x', [{name: 'x', kind: 'agent'}]));
  t.false(isAgentProfile('pwsh', [{name: 'pwsh'}]));
});

test('describeCloneLaunch', (t) => {
  t.is(describeCloneLaunch({profile: 'picker'}), '');
  t.is(describeCloneLaunch(undefined), '');
  t.is(describeCloneLaunch({profile: 'claude code'}), 'claude code');
  t.is(describeCloneLaunch({profile: 'pwsh', command: 'n8 --danger'}), '`n8 --danger` (in pwsh)');
});
