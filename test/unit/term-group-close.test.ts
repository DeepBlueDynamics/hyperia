import test from 'ava';

import {groupForPane} from '../../lib/utils/term-groups';

// One tab split into a terminal (session s-term in group g-term) and a web pane
// (group w-web, no session), plus the human's pane in another tab.
const state = {
  termGroups: {
    root: {uid: 'root', sessionUid: null, parentUid: null, children: ['g-term', 'w-web']},
    'g-term': {uid: 'g-term', sessionUid: 's-term', parentUid: 'root', children: []},
    'w-web': {
      uid: 'w-web',
      sessionUid: null,
      webUrl: 'http://localhost:5001/dashboard',
      parentUid: 'root',
      children: []
    },
    'g-human': {uid: 'g-human', sessionUid: 's-human', parentUid: null, children: []}
  },
  activeTermGroup: 'g-human'
} as any;

test('a terminal pane closes its own group', (t) => {
  t.is(groupForPane(state, 's-term'), 'g-term');
});

test('a web pane is found by its own id: it has no session', (t) => {
  t.is(groupForPane(state, 'w-web'), 'w-web');
});

test('an unknown or container id closes nothing, never the active pane', (t) => {
  t.is(groupForPane(state, 'gone'), null);
  t.is(groupForPane(state, ''), null);
  // A split container is not a pane.
  t.is(groupForPane(state, 'root'), null);
});
