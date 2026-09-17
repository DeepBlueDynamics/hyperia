import type {BrowserWindow} from 'electron';

import {writeStickyHidden} from './preferences';
import {SEARCH_WIN_ID} from './registry';

export interface WindowVisibilityState {
  win: BrowserWindow;
  ready: boolean;
  desiredVisible: boolean;
  focusPending: boolean;
}

const windowStates = new Map<string, WindowVisibilityState>();

function apply(id: string, st: WindowVisibilityState): void {
  if (!st.ready || st.win.isDestroyed()) return;

  if (st.desiredVisible) {
    st.win.setAlwaysOnTop(true, 'floating');
    if (process.platform === 'darwin' && typeof st.win.setVisibleOnAllWorkspaces === 'function') {
      st.win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: true});
    }
    if (st.focusPending) {
      st.focusPending = false;
      st.win.show();
      st.win.focus();
      st.win.webContents.focus();
    } else {
      st.win.showInactive();
    }
  } else {
    st.focusPending = false;
    st.win.hide();
  }
}

export function register(id: string, win: BrowserWindow, opts: {startHidden?: boolean; focus?: boolean} = {}): void {
  const desiredVisible = !opts.startHidden;
  const focusPending = desiredVisible ? !!opts.focus : false;

  const st: WindowVisibilityState = {
    win,
    ready: false,
    desiredVisible,
    focusPending
  };
  windowStates.set(id, st);

  win.once('ready-to-show', () => {
    st.ready = true;
    apply(id, st);
  });

  win.on('show', () => {
    const current = windowStates.get(id);
    if (!current || !current.desiredVisible || !current.ready) {
      if (!win.isDestroyed()) win.hide();
    }
  });
}

export function reveal(id: string, focus: boolean = false): void {
  const st = windowStates.get(id);
  if (!st) return;
  st.desiredVisible = true;
  st.focusPending = focus;
  apply(id, st);
}

export function hide(id: string): void {
  const st = windowStates.get(id);
  if (!st) return;
  st.desiredVisible = false;
  st.focusPending = false;
  apply(id, st);
}

export function unregister(id: string): void {
  windowStates.delete(id);
}

export function hideAll(exceptId?: string): void {
  if (!exceptId) {
    writeStickyHidden(true);
  }
  for (const [id, st] of windowStates.entries()) {
    if (id === SEARCH_WIN_ID || (exceptId && id === exceptId)) continue;
    st.desiredVisible = false;
    st.focusPending = false;
    apply(id, st);
  }
}

export function showAll(): void {
  writeStickyHidden(false);
  for (const [id, st] of windowStates.entries()) {
    if (id === SEARCH_WIN_ID) continue;
    st.desiredVisible = true;
    st.focusPending = false;
    apply(id, st);
  }
}

export function isDesiredVisible(id: string): boolean {
  const st = windowStates.get(id);
  return st ? st.desiredVisible : false;
}

export function anyStickyVisible(): boolean {
  for (const [id, st] of windowStates.entries()) {
    if (id === SEARCH_WIN_ID) continue;
    if (!st.win.isDestroyed() && st.win.isVisible()) return true;
  }
  return false;
}

export function anyStickyHidden(): boolean {
  for (const [id, st] of windowStates.entries()) {
    if (id === SEARCH_WIN_ID) continue;
    if (!st.win.isDestroyed() && !st.win.isVisible()) return true;
  }
  return false;
}

export function otherStickysVisible(exceptId: string): boolean {
  for (const [id, st] of windowStates.entries()) {
    if (id === SEARCH_WIN_ID || id === exceptId) continue;
    if (!st.win.isDestroyed() && st.win.isVisible()) return true;
  }
  return false;
}

export {hideAll as hideAllStickys, hide as hideSticky, showAll as showAllStickys};
