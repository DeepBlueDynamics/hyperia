/* eslint-disable eslint-comments/disable-enable-pair */

import {mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

const {readWorkspaceForBoot} = proxyquire('../../app/workspace', {
  electron: {app: {}, screen: {getDisplayMatching: () => ({id: 1}), getAllDisplays: () => []}},
  './window-state': {boundsAreVisible: () => true},
  './sticky': {listOpenStickyRefs: () => [], readAllNotes: () => [], createStickyNote: () => ({})}
});

const dir = mkdtempSync(join(tmpdir(), 'hyperia-boot-test-'));
const write = (name: string, content: string): string => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

const validWs = {
  kind: 'hyperia-workspace',
  schemaVersion: 1,
  name: 'last-session',
  savedAt: '2026-08-28T00:00:00Z',
  windows: [{geometry: {x: 0, y: 0, width: 800, height: 600}, layout: {termGroups: {}, sessions: {}}}]
};

test('boot read accepts a valid last-session file', (t) => {
  const p = write('valid.json', JSON.stringify(validWs));
  const ws = readWorkspaceForBoot(p);
  t.truthy(ws);
  t.is(ws!.windows.length, 1);
});

test('boot read returns null for every failure shape (fresh-window fallback)', (t) => {
  t.is(readWorkspaceForBoot(join(dir, 'absent.json')), null, 'missing file');
  t.is(readWorkspaceForBoot(write('garbage.json', '{ nope')), null, 'unparseable');
  t.is(readWorkspaceForBoot(write('wrong-kind.json', JSON.stringify({...validWs, kind: 'other'}))), null, 'wrong kind');
  t.is(
    readWorkspaceForBoot(write('future.json', JSON.stringify({...validWs, schemaVersion: 99}))),
    null,
    'future schema version'
  );
  t.is(readWorkspaceForBoot(write('no-windows.json', JSON.stringify({...validWs, windows: []}))), null, 'no windows');
  t.is(
    readWorkspaceForBoot(write('no-version.json', JSON.stringify({kind: 'hyperia-workspace', windows: [{}]}))),
    null,
    'missing schemaVersion'
  );
});
