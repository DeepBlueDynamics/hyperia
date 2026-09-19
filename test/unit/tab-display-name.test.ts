/* eslint-disable eslint-comments/disable-enable-pair */

import test from 'ava';

import {restoredTabName} from '../../lib/utils/restored-tab-name';
import {openTabDisplayNames, resolveTabDisplayName} from '../../lib/utils/tab-display-name';

const termGroups: Record<string, any> = {
  rootRenamed: {uid: 'rootRenamed', parentUid: null, tabName: 'Bob', children: ['leafA']},
  leafA: {uid: 'leafA', parentUid: 'rootRenamed', sessionUid: 's1', children: []},
  // A non-renamed tab: no tabName — its name comes from the session codename.
  rootAuto: {uid: 'rootAuto', parentUid: null, children: ['leafB']},
  leafB: {uid: 'leafB', parentUid: 'rootAuto', sessionUid: 's2', children: []},
  // A web-only tab.
  rootWeb: {uid: 'rootWeb', parentUid: null, children: ['leafC']},
  leafC: {uid: 'leafC', parentUid: 'rootWeb', sessionUid: null, webUrl: 'https://example.com/x', children: []}
};
const sessions: Record<string, any> = {
  s1: {uid: 's1', title: 'zsh'},
  s2: {uid: 's2', title: 'Massive Alpaca'}
};

test('a renamed tab resolves to its tabName', (t) => {
  t.is(resolveTabDisplayName(termGroups.rootRenamed, termGroups, sessions), 'Bob');
});

test('a non-renamed tab resolves to its session name (the bug: it has no tabName)', (t) => {
  t.is(resolveTabDisplayName(termGroups.rootAuto, termGroups, sessions), 'Massive Alpaca');
});

test('a web-only tab resolves to its URL host', (t) => {
  t.is(resolveTabDisplayName(termGroups.rootWeb, termGroups, sessions), 'example.com');
});

test('openTabDisplayNames includes auto-named tabs, so a restored copy collides', (t) => {
  const open = openTabDisplayNames(termGroups, sessions);
  t.deepEqual([...open].sort(), ['Bob', 'Massive Alpaca', 'example.com']);
  // Restoring the non-renamed tab while the original is open now gets a suffix
  // (previously it kept the same name because tabName was empty).
  t.is(restoredTabName('Massive Alpaca', open), 'Massive Alpaca (2)');
});
