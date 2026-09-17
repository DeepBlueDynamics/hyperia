/* eslint-disable eslint-comments/disable-enable-pair */

import {existsSync, readFileSync, writeFileSync} from 'fs';

import test from 'ava';

import {createStickyFixture} from '../helpers/sticky-main-fixture';
import type {FakeBrowserWindow} from '../helpers/sticky-main-fixture';

// ── 1. Structural & Wiring Checks ──────────────────────────────────────────

test.serial('structural wiring: createStickyNote loads existing sticky.html in dev mode', (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({text: 'path-check'});
  const win = res.win as FakeBrowserWindow;
  t.truthy(win.loadedFile, 'win.loadFile must be called');
  t.true(win.loadedFile!.endsWith('sticky.html'));
  t.false(win.loadedFile!.includes('app/sticky/sticky.html'), 'must resolve from app/ root, not app/sticky/');
  t.true(existsSync(win.loadedFile!), `loadedFile must exist on disk: ${win.loadedFile}`);
});

test.serial('structural wiring: generateNoteName collision avoidance via createStickyNote', (t) => {
  const f = createStickyFixture(t);
  // Seed an existing note named "Bold Badger"
  writeFileSync(f.notesFile, JSON.stringify([{id: 'existing-1', name: 'Bold Badger', text: ''}]));

  let callCount = 0;
  Math.random = () => {
    callCount++;
    if (callCount === 1) return 0.5; // note ID draw
    if (callCount === 2) return 0; // attempt 1 adj: 'Bold'
    if (callCount === 3) return 0; // attempt 1 animal: 'Badger' -> collides with Bold Badger
    if (callCount === 4) return 1.5 / 56; // attempt 2 adj: 'Brave'
    if (callCount === 5) return 1.5 / 62; // attempt 2 animal: 'Beaver'
    return 0.5; // no emoji
  };

  const res = f.sticky.createStickyNote();
  t.is(res.name, 'Brave Beaver', 'must skip colliding "Bold Badger" and select "Brave Beaver"');
});

test.serial('structural wiring: generateNoteName handles exhaustion fallback via createStickyNote', (t) => {
  const f = createStickyFixture(t);
  writeFileSync(f.notesFile, JSON.stringify([{id: 'existing-1', name: 'Bold Badger', text: ''}]));

  Math.random = () => 0;

  const res = f.sticky.createStickyNote();
  t.is(res.name, 'Bold Badger 2', 'must use exhaustion fallback index when candidate is always taken');
});

test.serial('structural wiring: app/sticky facade exports all required public API symbols', (t) => {
  const f = createStickyFixture(t);
  const expectedExports = [
    'initSticky',
    'createStickyNote',
    'closeStickyNote',
    'deleteStickyNote',
    'updateStickyNote',
    'scheduleSticky',
    'unscheduleSticky',
    'anyStickyVisible',
    'anyStickyHidden',
    'readAllNotes',
    'readStickyHidden',
    'listOpenStickyRefs'
  ];

  for (const exp of expectedExports) {
    t.is(typeof (f.sticky as any)[exp], 'function', `sticky facade must export ${exp}`);
  }
});

// ── 2. Preferences & Startup Opacity ────────────────────────────────────────

test.serial('preferences: persisted defaults.seeThrough=true sets startup-opacity to 0.6', (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  writeFileSync(f.defaultsFile, JSON.stringify({seeThrough: true}));
  f.sticky.initSticky();

  const res = f.sticky.createStickyNote({text: 'trans'});
  const win = res.win as FakeBrowserWindow;
  t.is(win.opacity, 0.6, 'startup opacity must be 0.6 when seeThrough is persisted true');
});

test.serial('preferences: persisted defaults.seeThrough=false sets startup-opacity to 1.0', (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  writeFileSync(f.defaultsFile, JSON.stringify({seeThrough: false}));
  f.sticky.initSticky();

  const res = f.sticky.createStickyNote({text: 'solid'});
  const win = res.win as FakeBrowserWindow;
  t.is(win.opacity, 1.0, 'startup opacity must be 1.0 when seeThrough is persisted false');
});

// ── 3. Lifecycle & Persistence Invariants ───────────────────────────────────

test.serial('invariant: closeStickyNote marks open:false and keeps record; deleteStickyNote removes it', (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({text: 'lifecycle'});
  const noteId = res.id;

  t.is(f.sticky.readAllNotes().length, 1);
  t.is(f.sticky.readAllNotes()[0].open, true);

  const closed = f.sticky.closeStickyNote(noteId);
  t.true(closed);
  t.is(f.sticky.readAllNotes().length, 1);
  t.is(f.sticky.readAllNotes()[0].open, false);
  t.truthy(f.sticky.readAllNotes()[0].last_closed_at);

  const deleted = f.sticky.deleteStickyNote(noteId);
  t.true(deleted);
  t.is(f.sticky.readAllNotes().length, 0);
});

test.serial('invariant: duplicate createStickyNote with startHidden does not reveal hidden window', (t) => {
  const f = createStickyFixture(t);
  const res1 = f.sticky.createStickyNote({text: 'dup', startHidden: true});
  const win = res1.win as FakeBrowserWindow;
  t.false(win.isVisible(), 'window should be hidden initially');

  const res2 = f.sticky.createStickyNote({id: res1.id, startHidden: true});
  t.is(res2.win, win);
  t.false(win.isVisible(), 'window must stay hidden after second startHidden call');
});

test.serial('invariant: notes.json preserves unknown fields across updates', (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({text: 'initial'});
  const notes = JSON.parse(readFileSync(f.notesFile, 'utf8'));
  notes[0].customField = 'preserve-me';
  notes[0].extraMetadata = {score: 99};
  writeFileSync(f.notesFile, JSON.stringify(notes));

  f.sticky.updateStickyNote(res.id, 'updated text');
  const updated = JSON.parse(readFileSync(f.notesFile, 'utf8'));
  t.is(updated[0].text, 'updated text');
  t.is(updated[0].customField, 'preserve-me', 'customField must be preserved');
  t.deepEqual(updated[0].extraMetadata, {score: 99}, 'extraMetadata must be preserved');
});

test.serial('invariant: startup 400ms callback restores open notes respecting persisted hidden', (t) => {
  const f = createStickyFixture(t, {autoInit: false});
  writeFileSync(f.stateFile, JSON.stringify({hidden: true}));
  writeFileSync(f.notesFile, JSON.stringify([{id: 'boot-note', name: 'Boot Note', open: true, text: 'restored'}]));

  f.sticky.initSticky();
  t.is(f.windows.length, 0, 'no window before startup timer');

  f.triggerStartupRestore();

  t.is(f.windows.length, 1, 'window opened on startup');
  const win = f.windows[0];

  win.emit('ready-to-show');
  t.false(win.isVisible(), 'startup restored note must remain hidden after ready-to-show');

  win.show();
  t.false(win.isVisible(), 'show-event guard must keep startedHidden window hidden when global hidden is true');
});

// ── 4. Deletion Edge Cases ──────────────────────────────────────────────────

test.serial('deletion: delayed update after delete returns false and does not recreate window', (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({text: 'initial'});
  const deleted = f.sticky.deleteStickyNote(res.id);
  t.true(deleted);

  const updated = f.sticky.updateStickyNote(res.id, 'after delete text');
  t.false(updated, 'updateStickyNote must return false after note was deleted');
  t.is(f.sticky.readAllNotes().length, 0, 'notes store must remain empty');
});

test.serial('deletion: explicit open of missing persisted ID returns win: null', (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({id: 'missing-persisted-note'});
  t.is(res.win, null, 'createStickyNote with unpersisted ID must return win: null');
  t.is(res.error, 'Note not found');

  // Passing text/creator must not recreate missing persistent id
  const resWithData = f.sticky.createStickyNote({
    id: 'missing-with-text-creator',
    text: 'attempted recreation',
    creator: 'agent'
  });
  t.is(resWithData.win, null, 'passing text/creator must not recreate missing persistent ID');
  t.is(resWithData.error, 'Note not found');

  t.is(f.sticky.readAllNotes().length, 0, 'missing IDs must not be added to notes.json');
});

test.serial('deletion: scheduler tick after note deletion does not resurrect note', async (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({text: 'scheduled note'});
  f.sticky.scheduleSticky(res.id, {when: 'reminder', runner: 'notify'});

  f.sticky.deleteStickyNote(res.id);
  t.is(f.sticky.readAllNotes().length, 0);

  await f.triggerSchedulerTick();
  t.is(f.sticky.readAllNotes().length, 0, 'scheduler tick must not resurrect deleted note');
});
