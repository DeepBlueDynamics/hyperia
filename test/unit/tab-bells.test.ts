/* eslint-disable @typescript-eslint/no-var-requires */
import {readFileSync} from 'fs';
import {resolve} from 'path';

import test from 'ava';

import type {HyperActions, HyperState} from '../../typings/hyper';

// Run the real combined reducer and all three real slice reducers. Only the
// Electron plugin decorators and declaration-file runtime constants are stubbed.
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const stubs: Record<string, any> = {
  '../utils/plugins': {
    decorateUIReducer: (reducer: unknown) => reducer,
    decorateSessionsReducer: (reducer: unknown) => reducer,
    decorateTermGroupsReducer: (reducer: unknown) => reducer
  }
};
for (const name of ['config', 'notifications', 'sessions', 'term-groups', 'ui', 'updater']) {
  const source = readFileSync(resolve(__dirname, '../../typings/constants', name + '.d.ts'), 'utf8');
  stubs['../../typings/constants/' + name] = Object.fromEntries(
    [...source.matchAll(/export const (\w+) = ['"]([^'"]+)['"]/g)].map((match) => [match[1], match[2]])
  );
}
if (typeof navigator === 'undefined')
  Object.defineProperty(globalThis, 'navigator', {
    value: {platform: 'Linux'}
  });
const reducer = proxyquire('../../lib/reducers', {
  './ui': proxyquire('../../lib/reducers/ui', stubs),
  './sessions': proxyquire('../../lib/reducers/sessions', stubs),
  './term-groups': proxyquire('../../lib/reducers/term-groups', stubs)
}).default as (state: HyperState | undefined, action: HyperActions) => HyperState;
/* eslint-enable @typescript-eslint/no-var-requires */

const act = (state: HyperState | undefined, type: string, uid = '') => reducer(state, {type, uid} as HyperActions);

function fixture() {
  const state = act(undefined, '@@init');
  const leaf = (uid: string, sessionUid: string | null, parentUid: string | null) => ({
    uid,
    sessionUid,
    parentUid,
    children: [],
    direction: null,
    sizes: null
  });
  return {
    ...state,
    termGroups: state.termGroups.merge({
      termGroups: {
        a: {...leaf('a', null, null), children: ['a1', 'a2', 'web']},
        a1: leaf('a1', 's1', 'a'),
        a2: leaf('a2', 's2', 'a'),
        web: {...leaf('web', null, 'a'), webUrl: 'https://example.com'},
        b: leaf('b', 's3', null)
      },
      activeRootGroup: 'b',
      activeTermGroup: 'b',
      activeSessions: {a: 's1', b: 's3'}
    })
  };
}

function ringing() {
  return ['s1', 's2', 'web', 's3'].reduce((state, uid) => act(state, 'UI_TAB_BELL_SET', uid), fixture());
}

test('selecting a tab acknowledges every sibling but clears only the focused pane', (t) => {
  const before = ringing();
  const next = act(before, 'SESSION_SET_ACTIVE', 's1');
  t.is(next.termGroups.activeRootGroup, 'a');
  t.deepEqual(next.ui.bellMarkers.asMutable(), {
    s2: 'seen',
    web: 'seen',
    s3: true
  });
  t.deepEqual(before.ui.bellMarkers.asMutable(), {
    s1: true,
    s2: true,
    web: true,
    s3: true
  });
});

test('terminal and web focus clear only their own persistent bells', (t) => {
  const selected = act(ringing(), 'SESSION_SET_ACTIVE', 's1');
  const terminal = act(selected, 'SESSION_SET_ACTIVE', 's2');
  t.deepEqual(terminal.ui.bellMarkers.asMutable(), {web: 'seen', s3: true});
  const web = act(terminal, 'TERM_GROUP_SET_ACTIVE', 'web');
  t.deepEqual(web.ui.bellMarkers.asMutable(), {s3: true});
});

test('selecting a web pane across tabs acknowledges its terminal siblings', (t) => {
  const next = act(ringing(), 'TERM_GROUP_SET_ACTIVE', 'web');
  t.is(next.termGroups.activeRootGroup, 'a');
  t.deepEqual(next.ui.bellMarkers.asMutable(), {
    s1: 'seen',
    s2: 'seen',
    s3: true
  });
});

test('a new bell makes a seen pane unseen again without acknowledging siblings', (t) => {
  const selected = act(ringing(), 'SESSION_SET_ACTIVE', 's1');
  const next = act(selected, 'UI_TAB_BELL_SET', 's2');
  t.deepEqual(next.ui.bellMarkers.asMutable(), {
    s2: true,
    web: 'seen',
    s3: true
  });
});

test('unrelated actions preserve state identity and unseen bells in the active tab', (t) => {
  const selected = act(ringing(), 'SESSION_SET_ACTIVE', 's1');
  const before = act(selected, 'UI_TAB_BELL_SET', 's2');
  t.is(act(before, '@@unrelated'), before);
  const focused = act(before, 'SESSION_SET_ACTIVE', 's1');
  t.is(focused.ui.bellMarkers, before.ui.bellMarkers);
});

test('explicit consent or timer clearing removes both unseen and seen markers', (t) => {
  const selected = act(ringing(), 'SESSION_SET_ACTIVE', 's1');
  const next = act(act(selected, 'UI_TAB_BELL_CLEAR', 'web'), 'UI_TAB_BELL_CLEAR', 's3');
  t.deepEqual(next.ui.bellMarkers.asMutable(), {s2: 'seen'});
  t.is(act(next, 'UI_TAB_BELL_CLEAR', 'missing'), next);
});

test('a tab switch without bells preserves the UI slice identity', (t) => {
  const before = fixture();
  const next = act(before, 'TERM_GROUP_SET_ACTIVE', 'web');
  t.is(next.ui, before.ui);
  t.not(next, before);
});
