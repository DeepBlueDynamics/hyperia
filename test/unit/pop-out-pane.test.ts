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
/* eslint-enable @typescript-eslint/no-var-requires */

const leaf = (uid: string, sessionUid: string, parentUid: string) => ({
  uid,
  sessionUid,
  parentUid,
  children: [],
  direction: null,
  sizes: null
});

// Tab `r` split into panes; the moved pane (s2) is the focused one, as after a right-click.
function split(children: string[]) {
  const groups: Record<string, any> = {
    r: {uid: 'r', sessionUid: null, parentUid: null, children, direction: 'VERTICAL', sizes: null}
  };
  children.forEach((uid, i) => (groups[uid] = leaf(uid, 's' + (i + 1), 'r')));
  const init = reducer(undefined, {type: '@@init'});
  return init.merge({termGroups: groups, activeRootGroup: 'r', activeTermGroup: 'b', activeSessions: {r: 's2'}} as any);
}

// Mirrors setActiveGroup(): a tab click activates the tab's remembered session.
const clickTab = (state: ITermState, rootUid: string) =>
  reducer(state, {type: 'SESSION_SET_ACTIVE', uid: state.activeSessions[rootUid]});

const roots = (state: ITermState) => Object.keys(state.termGroups).filter((uid) => !state.termGroups[uid].parentUid);

for (const children of [
  ['a', 'b'],
  ['a', 'b', 'c']
]) {
  test(`pop out of a ${children.length}-pane tab: each tab click selects that tab`, (t) => {
    const moved = reducer(split(children), {type: 'TERM_GROUP_POP_OUT_PANE', uid: 'b'});
    const oldRoot = roots(moved).find((uid) => uid !== 'b')!;
    t.is(moved.activeRootGroup, 'b');
    t.is(moved.activeSessions.b, 's2');
    // The old tab must no longer remember the moved pane's session.
    t.not(moved.activeSessions[oldRoot], 's2');

    const onOld = clickTab(moved, oldRoot);
    t.is(onOld.activeRootGroup, oldRoot);
    t.is(clickTab(onOld, 'b').activeRootGroup, 'b');
  });
}
