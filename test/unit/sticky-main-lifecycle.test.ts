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
    'setRun',
    'clearRun',
    'runNow',
    'pauseRun',
    'setResult',
    'setRunState',
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
  f.sticky.setRun(res.id, {when: 'at', at: new Date().toISOString(), target: 'notify'});

  f.sticky.deleteStickyNote(res.id);
  t.is(f.sticky.readAllNotes().length, 0);

  await f.triggerSchedulerTick();
  t.is(f.sticky.readAllNotes().length, 0, 'scheduler tick must not resurrect deleted note');
});

// ── Default sizing (#77) ────────────────────────────────────────────────────

test.serial('default size: plain note scales off the 1920x1080 work area', (t) => {
  const f = createStickyFixture(t);
  const win = f.sticky.createStickyNote({text: 'hi'}).win as FakeBrowserWindow;
  t.is(win.opts.width, 480); // 25% of 1920, inside [360, 560]
  t.is(win.opts.height, 378); // 35% of 1080, inside [280, 520]
});

test.serial('default size: code note opens large', (t) => {
  const f = createStickyFixture(t);
  const win = f.sticky.createStickyNote({text: 'x', color: 'code:dark'}).win as FakeBrowserWindow;
  t.is(win.opts.width, 960);
  t.is(win.opts.height, 702);
});

test.serial('default size: larger font size grows the bounds', (t) => {
  const f = createStickyFixture(t);
  writeFileSync(f.defaultsFile, JSON.stringify({fontSize: 44}));
  const win = f.sticky.createStickyNote({text: 'hi'}).win as FakeBrowserWindow;
  t.is(win.opts.width, 720); // min 360 * 2
  t.is(win.opts.height, 560); // min 280 * 2
});

test.serial('default size: defaults.json width/height override plain notes', (t) => {
  const f = createStickyFixture(t);
  writeFileSync(f.defaultsFile, JSON.stringify({width: 300, height: 250}));
  const win = f.sticky.createStickyNote({text: 'hi'}).win as FakeBrowserWindow;
  t.is(win.opts.width, 300);
  t.is(win.opts.height, 250);
});

test.serial('default size: explicit width/height still win', (t) => {
  const f = createStickyFixture(t);
  const win = f.sticky.createStickyNote({text: 'hi', width: 700, height: 500}).win as FakeBrowserWindow;
  t.is(win.opts.width, 700);
  t.is(win.opts.height, 500);
});

// ── Fit to content (#280) ───────────────────────────────────────────────────

const fitParam = (win: FakeBrowserWindow) => new URLSearchParams(win.loadedSearch || '').get('fit');

test.serial('fit: new note with text is offered a one-shot fit with grow-only caps', (t) => {
  const f = createStickyFixture(t);
  const win = f.sticky.createStickyNote({text: 'lots of instructions'}).win as FakeBrowserWindow;
  // max 60% x 70% of 1920x1080; min = the default it opened at (grow only)
  t.is(fitParam(win), '1152,756,480,378');
});

test.serial('fit: code note may shrink to the plain default', (t) => {
  const f = createStickyFixture(t);
  const win = f.sticky.createStickyNote({text: 'x', color: 'code:dark'}).win as FakeBrowserWindow;
  t.is(fitParam(win), '1152,756,480,378');
});

test.serial('fit: not offered for empty, explicitly sized, or reopened notes', (t) => {
  const f = createStickyFixture(t);
  t.is(fitParam(f.sticky.createStickyNote().win as FakeBrowserWindow), null);
  t.is(fitParam(f.sticky.createStickyNote({text: 'hi', width: 500, height: 400}).win as FakeBrowserWindow), null);
  const {id} = f.sticky.createStickyNote({text: 'hi'});
  f.sticky.closeStickyNote(id);
  t.is(fitParam(f.sticky.createStickyNote({id}).win as FakeBrowserWindow), null);
});

test.serial('fit: applied once, clamped, kept on-screen, and persisted', (t) => {
  const f = createStickyFixture(t);
  const {win, id} = f.sticky.createStickyNote({text: 'hi', x: 1700, y: 900}) as {win: FakeBrowserWindow; id: string};
  f.ipcEmitFrom(win.webContents, 'sticky-fit', id, {width: 5000, height: 600});
  const b = win.getBounds();
  t.deepEqual(b, {x: 1920 - 1152, y: 1080 - 600, width: 1152, height: 600});
  const saved = JSON.parse(readFileSync(f.notesFile, 'utf8')).find((n: any) => n.id === id);
  t.like(saved, {x: b.x, y: b.y, width: 1152, height: 600});
  t.false(win.focused, 'fit must not focus the note');

  // Second request is ignored.
  f.ipcEmitFrom(win.webContents, 'sticky-fit', id, {width: 600, height: 500});
  t.deepEqual(win.getBounds(), b);
});

test.serial('fit: plain note never shrinks below where it opened', (t) => {
  const f = createStickyFixture(t);
  const {win, id} = f.sticky.createStickyNote({text: 'hi'}) as {win: FakeBrowserWindow; id: string};
  f.ipcEmitFrom(win.webContents, 'sticky-fit', id, {width: 100, height: 100});
  t.like(win.getBounds(), {width: 480, height: 378});
});

test.serial('fit: request from another note window is ignored', (t) => {
  const f = createStickyFixture(t);
  const a = f.sticky.createStickyNote({text: 'a'}) as {win: FakeBrowserWindow; id: string};
  const b = f.sticky.createStickyNote({text: 'b'}) as {win: FakeBrowserWindow; id: string};
  f.ipcEmitFrom(b.win.webContents, 'sticky-fit', a.id, {width: 900, height: 700});
  t.like(a.win.getBounds(), {width: 480, height: 378});
});
