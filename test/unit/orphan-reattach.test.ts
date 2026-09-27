/* eslint-disable @typescript-eslint/no-var-requires */
import {readFileSync} from 'fs';
import {resolve} from 'path';

import test from 'ava';

import type {ITermState} from '../../typings/hyper';

// Real term-groups reducer; only the plugin decorator and .d.ts constants are stubbed.
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const stubs: Record<string, any> = {
  '../utils/plugins': {decorateTermGroupsReducer: (reducer: unknown) => reducer}
};
for (const name of ['sessions', 'term-groups']) {
  const source = readFileSync(resolve(__dirname, '../../typings/constants', name + '.d.ts'), 'utf8');
  stubs['../../typings/constants/' + name] = Object.fromEntries(
    [...source.matchAll(/export const (\w+) = ['"]([^'"]+)['"]/g)].map((match) => [match[1], match[2]])
  );
}
const reducer = proxyquire('../../lib/reducers/term-groups', stubs).default as (s: any, a: any) => ITermState;
const {SESSION_ADD} = stubs['../../typings/constants/sessions'];
/* eslint-enable @typescript-eslint/no-var-requires */

// One visible tab `r` (session s1), focused.
const oneTab = () =>
  reducer(undefined, {type: '@@init'}).merge({
    termGroups: {r: {uid: 'r', sessionUid: 's1', parentUid: null, children: [], direction: null, sizes: null}},
    activeRootGroup: 'r',
    activeTermGroup: 'r',
    activeSessions: {r: 's1'}
  } as any);

const groupsFor = (state: ITermState, sessionUid: string) =>
  Object.values(state.termGroups).filter((g: any) => g.sessionUid === sessionUid);

test('a plain restore does not create a tab (its layout already has one)', (t) => {
  const next = reducer(oneTab(), {type: SESSION_ADD, uid: 'orphan', isNewGroup: true, isRestore: true});
  t.is(groupsFor(next, 'orphan').length, 0);
});

test('an orphan reattach creates a tab for the live session', (t) => {
  const next = reducer(oneTab(), {
    type: SESSION_ADD,
    uid: 'orphan',
    isNewGroup: true,
    isRestore: true,
    isReattach: true,
    isAgentInitiated: true
  });
  const groups = groupsFor(next, 'orphan');
  t.is(groups.length, 1);
  t.falsy((groups[0] as any).parentUid, 'it is a root group, i.e. a tab');
});

test('an orphan reattach does not steal focus from the current tab', (t) => {
  const next = reducer(oneTab(), {
    type: SESSION_ADD,
    uid: 'orphan',
    isNewGroup: true,
    isRestore: true,
    isReattach: true,
    isAgentInitiated: true
  });
  t.is(next.activeRootGroup, 'r');
  t.is(next.activeTermGroup, 'r');
});
