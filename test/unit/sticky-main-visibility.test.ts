/* eslint-disable eslint-comments/disable-enable-pair */

import test from 'ava';

import {createStickyFixture} from '../helpers/sticky-main-fixture';
import type {FakeBrowserWindow} from '../helpers/sticky-main-fixture';

// ── 1. Visibility Controller & Toggling ─────────────────────────────────────

test.serial('visibility: hide-all and show-all IPC handlers toggle visibility and persist state', (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({text: 'show', startHidden: false});
  const win = res.win as FakeBrowserWindow;
  win.emit('ready-to-show');
  t.true(win.isVisible());
  t.true(f.sticky.anyStickyVisible());

  f.ipcEmit('hide-all-stickys');
  t.true(f.sticky.readStickyHidden(), 'readStickyHidden must be true');
  t.false(win.isVisible(), 'window must be hidden');
  t.true(f.sticky.anyStickyHidden());

  f.ipcEmit('show-all-stickys');
  t.false(f.sticky.readStickyHidden(), 'readStickyHidden must be false');
  t.true(win.isVisible());
});

test.serial('visibility: show-all then hide-again keeps all notes hidden', (t) => {
  const f = createStickyFixture(t);
  const res1 = f.sticky.createStickyNote({text: 'note1'});
  const res2 = f.sticky.createStickyNote({text: 'note2'});
  const win1 = res1.win as FakeBrowserWindow;
  const win2 = res2.win as FakeBrowserWindow;
  win1.emit('ready-to-show');
  win2.emit('ready-to-show');

  f.ipcEmit('show-all-stickys');
  t.false(f.sticky.readStickyHidden());
  t.true(win1.isVisible());
  t.true(win2.isVisible());

  f.ipcEmit('hide-all-stickys');
  t.true(f.sticky.readStickyHidden());
  t.false(win1.isVisible(), 'note 1 must be hidden after hide-all');
  t.false(win2.isVisible(), 'note 2 must be hidden after hide-all');
});

test.serial('visibility: search window opens with focus, reopens via reveal, and is excluded from global hide', (t) => {
  const f = createStickyFixture(t);
  // Open search window with focus: true
  const res = f.sticky.createStickyNote({id: 'sticky-search-window', focus: true});
  const win = res.win as FakeBrowserWindow;
  win.emit('ready-to-show');
  t.true(win.isVisible(), 'search window is visible on ready-to-show');
  t.true(win.isFocused(), 'search window opened with focus:true is focused');

  // Blur and reopen existing search window
  win.blur();
  t.false(win.isFocused());
  const reopenRes = f.sticky.createStickyNote({id: 'sticky-search-window', focus: true});
  t.is(reopenRes.win, win, 'reopening returns the existing search window');
  t.true(win.isVisible(), 'reopened search window remains visible');
  t.true(win.isFocused(), 'reopened search window is re-focused via reveal');

  // Normal sticky note is hidden by global hide, but search window stays visible
  const normalRes = f.sticky.createStickyNote({text: 'normal note'});
  const normalWin = normalRes.win as FakeBrowserWindow;
  normalWin.emit('ready-to-show');
  t.true(normalWin.isVisible());

  f.ipcEmit('hide-all-stickys');
  t.true(f.sticky.readStickyHidden());
  t.false(normalWin.isVisible(), 'normal note must be hidden by hide-all');
  t.true(win.isVisible(), 'search window must remain visible (excluded from global hide)');
});

// ── 2. Readiness & Race Conditions ──────────────────────────────────────────

test.serial('race condition: hideAllStickys before ready-to-show keeps note hidden', (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({startHidden: false});
  const win = res.win as FakeBrowserWindow;

  // Hide all while window is still loading before ready-to-show
  f.ipcEmit('hide-all-stickys');
  t.true(f.sticky.readStickyHidden());

  // ready-to-show fires afterwards
  win.emit('ready-to-show');
  t.false(win.isVisible(), 'note must remain hidden if hideAllStickys occurred before ready-to-show');

  // Stray show call must be caught and re-hidden
  win.show();
  t.false(win.isVisible(), 'show-event guard must catch stray show on hidden note');
});

test.serial('race condition: explicit show-before-ready displays note on readiness', (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({startHidden: true});
  const win = res.win as FakeBrowserWindow;

  // User explicitly asks to open/show this note before ready-to-show
  f.sticky.createStickyNote({id: res.id, focus: true});

  // ready-to-show fires
  win.emit('ready-to-show');
  t.true(win.isVisible(), 'note must become visible when explicit open preceded ready-to-show');
});

// ── 3. Presentation & Focus Semantics ───────────────────────────────────────

test.serial('presentation: create with creator persists creator; tool open withoutcreator opens with no focus', (t) => {
  const f = createStickyFixture(t);
  // Create with creator
  const res = f.sticky.createStickyNote({text: 'agent note', creator: 'agent-42'});
  const win = res.win as FakeBrowserWindow;
  win.emit('ready-to-show');

  // Creator creation assertion
  const persisted = f.sticky.readAllNotes().find((n) => n.id === res.id);
  t.is(persisted?.creator, 'agent-42', 'creator must be persisted in notes.json');

  // Blur window
  win.blur();
  t.false(win.isFocused());
  const initialFocusCalls = win.focusCalls;

  // Tool open withoutcreator (e.g. NoteOpen bridge passing only id, focus:false default)
  const openRes = f.sticky.createStickyNote({id: res.id});
  t.is(openRes.win, win);
  t.true(win.isVisible(), 'tool open ensures window is visible');
  t.false(win.isFocused(), 'tool open withoutcreator must not steal focus');
  t.is(win.focusCalls, initialFocusCalls, 'no focus calls made');
});

test.serial('presentation: create while global hidden presents note without revealing others', (t) => {
  const f = createStickyFixture(t);
  const res1 = f.sticky.createStickyNote({text: 'note1'});
  const win1 = res1.win as FakeBrowserWindow;
  win1.emit('ready-to-show');

  f.ipcEmit('hide-all-stickys');
  t.true(f.sticky.readStickyHidden());
  t.false(win1.isVisible(), 'note 1 must be hidden');

  // Explicit agent/tool create while stickies are hidden
  const res2 = f.sticky.createStickyNote({text: 'note2', creator: 'agent'});
  const win2 = res2.win as FakeBrowserWindow;
  win2.emit('ready-to-show');

  t.true(win2.isVisible(), 'explicitly created note must be visible');
  t.false(win2.isFocused(), 'agent presentation must not take focus (uses showInactive)');
  t.false(win1.isVisible(), 'other notes must remain hidden');
  t.true(f.sticky.readStickyHidden(), 'global hidden preference must remain preserved');
});

test.serial('presentation: actual open-one while global hidden presents chosen note without revealing others', (t) => {
  const f = createStickyFixture(t);
  const res1 = f.sticky.createStickyNote({text: 'note1'});
  const res2 = f.sticky.createStickyNote({text: 'note2'});
  const win1 = res1.win as FakeBrowserWindow;
  const win2 = res2.win as FakeBrowserWindow;
  win1.emit('ready-to-show');
  win2.emit('ready-to-show');
  t.true(win1.isVisible());
  t.true(win2.isVisible());

  f.ipcEmit('hide-all-stickys');
  t.true(f.sticky.readStickyHidden());
  t.false(win1.isVisible(), 'note 1 must be hidden');
  t.false(win2.isVisible(), 'note 2 must be hidden');

  // Actual open-one: explicitly open only note 1 while global hidden
  const opened = f.sticky.createStickyNote({id: res1.id});
  t.is(opened.win, win1);
  t.true(win1.isVisible(), 'opened note 1 must become visible');
  t.false(win2.isVisible(), 'note 2 must remain hidden');
  t.true(f.sticky.readStickyHidden(), 'global hidden preference must remain preserved');
});

test.serial('presentation: background update while hidden keeps note hidden and un-focused', (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({text: 'initial'});
  const win = res.win as FakeBrowserWindow;
  win.emit('ready-to-show');
  t.true(win.isVisible());

  f.ipcEmit('hide-all-stickys');
  t.true(f.sticky.readStickyHidden());
  t.false(win.isVisible(), 'note must be hidden after hide-all-stickys');

  // Background update arrives while hidden
  f.sticky.updateStickyNote(res.id, 'new background text');

  t.false(win.isVisible(), 'note must remain hidden after background update while stickies are hidden');
  t.false(win.isFocused(), 'note must not be focused by background update while hidden');
});

test.serial('presentation: visible note update refreshes without stealing focus', (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({text: 'initial'});
  const win = res.win as FakeBrowserWindow;
  win.emit('ready-to-show');
  t.true(win.isVisible());

  // Blur the window
  win.blur();
  t.false(win.isFocused());
  const initialFocusCalls = win.focusCalls;

  f.sticky.updateStickyNote(res.id, 'updated text');
  t.true(win.isVisible());
  t.is(win.focusCalls, initialFocusCalls, 'visible background update must not steal focus');
  t.false(win.isFocused(), 'window must remain un-focused after background update');
});

// ── 4. Scheduler & Notification Semantics ───────────────────────────────────

test.serial('scheduler: schedule runner while hidden keeps note hidden and un-focused', async (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({text: 'reminder'});
  const win = res.win as FakeBrowserWindow;
  win.emit('ready-to-show');

  f.sticky.scheduleSticky(res.id, {when: 'reminder', delay: 0, unit: 'm', runner: 'notify'});

  f.ipcEmit('hide-all-stickys');
  t.true(f.sticky.readStickyHidden());
  t.false(win.isVisible());

  // Trigger 15s scheduler interval tick
  await f.triggerSchedulerTick();

  t.false(win.isVisible(), 'note must remain hidden when schedule fires while stickies are hidden');
  t.false(win.isFocused(), 'note must not be focused when schedule fires while stickies are hidden');
  t.truthy(f.notifications[0], 'notification is sent to the OS');
});

test.serial('scheduler: closed scheduler note stays closed', async (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({text: 'reminder'});
  f.sticky.scheduleSticky(res.id, {when: 'reminder', delay: 0, unit: 'm', runner: 'notify'});

  // Note is closed by user
  f.sticky.closeStickyNote(res.id);
  t.is(f.sticky.readAllNotes()[0].open, false);

  // Scheduler fires
  await f.triggerSchedulerTick();

  t.is(f.sticky.readAllNotes()[0].open, false, 'scheduler must not reopen closed note');
  const openWindows = f.windows.filter((w) => !w.isDestroyed());
  t.is(openWindows.length, 0, 'closed note window must not be reopened by scheduler');
});

test.serial('scheduler: stale notification click after note delete does not resurrect note', async (t) => {
  const f = createStickyFixture(t);
  const res = f.sticky.createStickyNote({text: 'reminder note'});
  const win = res.win as FakeBrowserWindow;
  win.emit('ready-to-show');

  f.sticky.scheduleSticky(res.id, {when: 'reminder', delay: 0, unit: 'm', runner: 'notify'});

  await f.triggerSchedulerTick();
  const notif = f.notifications[0];
  t.truthy(notif, 'notification was spawned by scheduler');

  // Delete note
  f.sticky.deleteStickyNote(res.id);
  t.is(f.sticky.readAllNotes().length, 0);

  // Stale notification click arrives later
  notif.emit('click');

  t.is(f.sticky.readAllNotes().length, 0, 'stale notification click must not resurrect note in notes.json');
  const openWindows = f.windows.filter((w) => !w.isDestroyed());
  t.is(openWindows.length, 0, 'stale notification click must not resurrect window');
});

// ── 5. Phase 4 Integration Semantics ────────────────────────────────────────

test.serial('phase 4 integration: open-matching-stickys replace=true archives replaced notes with open:false', (t) => {
  const f = createStickyFixture(t);
  const res1 = f.sticky.createStickyNote({text: 'replace-me'});
  const res2 = f.sticky.createStickyNote({text: 'keep-me'});
  const win1 = res1.win as FakeBrowserWindow;
  const win2 = res2.win as FakeBrowserWindow;
  win1.emit('ready-to-show');
  win2.emit('ready-to-show');

  t.is(f.sticky.readAllNotes().length, 2);

  // Trigger open-matching-stickys with replace=true, matching only res2.id
  f.ipcEmit('open-matching-stickys', [res2.id], true);

  const notes = f.sticky.readAllNotes();
  const note1 = notes.find((n) => n.id === res1.id)!;
  const note2 = notes.find((n) => n.id === res2.id)!;

  t.is(note1.open, false, 'replaced note must be closed with open: false');
  t.truthy(note1.last_closed_at, 'replaced note must record last_closed_at timestamp');
  t.is(note2.open, true, 'matched note must remain open');
});
