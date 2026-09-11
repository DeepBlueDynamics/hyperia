/* eslint-disable eslint-comments/disable-enable-pair */

import test from 'ava';

import {filterLayoutToTab, resumeCandidatesForTab, applyResumeSelections} from '../../lib/utils/workspace-tab';

const layout = () => ({
  activeUid: 's1',
  activeRootGroup: 'other-root',
  activeTermGroup: 'other-root',
  activeSessions: {root: 's1', 'other-root': 's9'},
  termGroups: {
    root: {uid: 'root', parentUid: null, sessionUid: null, children: ['leafA', 'leafB']},
    leafA: {uid: 'leafA', parentUid: 'root', sessionUid: 's1', children: []},
    leafB: {uid: 'leafB', parentUid: 'root', sessionUid: null, webUrl: 'https://x', children: []},
    'other-root': {uid: 'other-root', parentUid: null, sessionUid: 's9', children: []}
  },
  sessions: {
    s1: {uid: 's1', cwd: '/tmp', profile: 'zsh'},
    s9: {uid: 's9', cwd: '/elsewhere', profile: 'bash'}
  }
});

test('filterLayoutToTab keeps only the subtree and its sessions', (t) => {
  const tab = filterLayoutToTab(layout() as any, 'root')!;
  t.deepEqual(Object.keys(tab.termGroups).sort(), ['leafA', 'leafB', 'root']);
  t.deepEqual(Object.keys(tab.sessions), ['s1']);
  t.is(tab.activeRootGroup, 'root');
  // Foreign active pointers are re-scoped to the tab.
  t.is(tab.activeTermGroup, 'root');
  t.deepEqual(tab.activeSessions, {root: 's1'});
});

test('filterLayoutToTab rejects non-roots and unknown uids', (t) => {
  t.is(filterLayoutToTab(layout() as any, 'leafA'), null);
  t.is(filterLayoutToTab(layout() as any, 'ghost'), null);
});

test('resume candidates: n8 binding pre-checked, busy shell opt-in, scrape never offered', (t) => {
  const tab = filterLayoutToTab(
    {
      ...layout(),
      termGroups: {
        root: {uid: 'root', parentUid: null, sessionUid: null, children: ['a', 'b', 'c']},
        a: {uid: 'a', parentUid: 'root', sessionUid: 'agent', children: []},
        b: {uid: 'b', parentUid: 'root', sessionUid: 'server', children: []},
        c: {uid: 'c', parentUid: 'root', sessionUid: 'idle', children: []}
      },
      sessions: {
        agent: {uid: 'agent'},
        server: {uid: 'server'},
        idle: {uid: 'idle'}
      }
    } as any,
    'root'
  )!;
  const live = {
    agent: {shellName: 'Octo 🐙', n8Binding: {resume: 'n8 resume abc-123'}},
    server: {shellName: 'Dev 🌀', busy: true, shellState: {state: 'busy', command: 'npm run dev'}},
    // Idle pane with only a scraped-looking lastCommand: NOT a candidate.
    idle: {shellName: 'Idle 🦥', lastCommand: 'rm -rf / # scraped garbage', shellState: {state: 'idle'}}
  };
  const cands = resumeCandidatesForTab(tab, live as any);
  t.deepEqual(
    cands.map((c) => [c.sessionUid, c.source, c.preChecked, c.command]),
    [
      ['agent', 'n8', true, 'n8 resume abc-123'],
      ['server', 'shell', false, 'npm run dev']
    ]
  );
});

test('applyResumeSelections stamps resumeOnce only on selected sessions', (t) => {
  const tab = filterLayoutToTab(layout() as any, 'root')!;
  const out = applyResumeSelections(tab, [{sessionUid: 's1', command: 'n8 resume abc', source: 'n8'}]);
  t.deepEqual(out.sessions.s1.resumeOnce, {command: 'n8 resume abc', source: 'n8'});
  // Original untouched (pure), and unselected sessions carry nothing.
  t.is(tab.sessions.s1.resumeOnce, undefined);
});
