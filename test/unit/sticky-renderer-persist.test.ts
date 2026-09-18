/* eslint-disable eslint-comments/disable-enable-pair */
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const persistMod = require('../../app/sticky-renderer/persist');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const theme = require('../../app/sticky-renderer/theme');

test.beforeEach((t) => {
  t.timeout(20000);
});

const TEST_TMP = process.env.TMPDIR || tmpdir() || join(process.cwd(), '.hyperia-test-temp');

const makePersist = () => {
  mkdirSync(TEST_TMP, {recursive: true});
  const tmp = mkdtempSync(join(TEST_TMP, 'hyperia-sticky-renderer-'));
  mkdirSync(join(tmp, '.hyperia', 'stickys'), {recursive: true});
  return persistMod.createPersist({
    homedir: tmp,
    fs: require('fs'),
    path: require('path'),
    os: require('os')
  });
};

test('readNotes returns [] when notes.json is missing', (t) => {
  t.deepEqual(makePersist().readNotes(), []);
});

test('readNotes returns [] when notes.json is malformed', (t) => {
  const persist = makePersist();
  writeFileSync(persist.notesJson, '{not json', 'utf8');
  t.deepEqual(persist.readNotes(), []);
});

test('saveNote of findNote() preserves unknown fields', (t) => {
  const persist = makePersist();
  writeFileSync(
    persist.notesJson,
    JSON.stringify(
      [{id: 'note-1', name: 'A', text: 'hi', color: '#fff9c4', extra: {nested: true}, futureFlag: 7}],
      null,
      2
    ),
    'utf8'
  );
  const note = persist.findNote('note-1');
  t.truthy(note);
  note.text = 'updated';
  persist.saveNote(note);
  const round = JSON.parse(readFileSync(persist.notesJson, 'utf8'));
  t.is(round.length, 1);
  t.is(round[0].text, 'updated');
  t.deepEqual(round[0].extra, {nested: true});
  t.is(round[0].futureFlag, 7);
});

test('saving one note does not strip unknown fields on sibling notes', (t) => {
  const persist = makePersist();
  writeFileSync(
    persist.notesJson,
    JSON.stringify(
      [
        {id: 'note-1', name: 'A', text: 'a', agentMeta: {src: 'mcp'}},
        {id: 'note-2', name: 'B', text: 'b', extra: 1}
      ],
      null,
      2
    ),
    'utf8'
  );
  const one = persist.findNote('note-1');
  one.text = 'a2';
  persist.saveNote(one);
  const round = JSON.parse(readFileSync(persist.notesJson, 'utf8'));
  t.deepEqual(round.find((n: {id: string}) => n.id === 'note-1').agentMeta, {src: 'mcp'});
  t.is(round.find((n: {id: string}) => n.id === 'note-2').extra, 1);
});

test('saveNote of a partial object replaces the record (current renderer behavior)', (t) => {
  const persist = makePersist();
  writeFileSync(persist.notesJson, JSON.stringify([{id: 'note-1', name: 'A', keepMe: true}], null, 2), 'utf8');
  persist.saveNote({id: 'note-1', name: 'B'});
  const round = JSON.parse(readFileSync(persist.notesJson, 'utf8'));
  t.is(round[0].name, 'B');
  t.is(round[0].keepMe, undefined);
});

test('translateContainerPath is identity off Windows', (t) => {
  t.is(persistMod.translateContainerPath('/workspace/foo', {platform: 'linux'}), '/workspace/foo');
});

test('textColorForBg picks dark text on light backgrounds', (t) => {
  t.is(theme.textColorForBg('#fff9c4'), '#1a1a1a');
  t.is(theme.textColorForBg('#1e1e2e'), '#f0f0f0');
});

test('CODE_THEMES css files are packaged siblings of sticky.html', (t) => {
  t.is(theme.CODE_THEMES['code:light'].css, 'atom-one-light.min.css');
  t.is(theme.CODE_THEMES['code:dark'].css, 'atom-one-dark.min.css');
  t.true(existsSync(join(__dirname, '../../app/atom-one-light.min.css')));
  t.true(existsSync(join(__dirname, '../../app/atom-one-dark.min.css')));
});
