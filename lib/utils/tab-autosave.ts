/**
 * Session-only autosave for saved tab-workspaces. Ticking "Autosave" in the
 * Save Tab toast binds the tab to its saved name; from then on every change to
 * the tab (splits, closed panes, cwd, names, web URLs) re-saves it, debounced.
 * Bindings live in memory only and end with the tab or the window.
 *
 * Safety: resumeOnce is the one field restore executes, and it needs the
 * human's consent in the toast. Autosave only re-stamps a command the human
 * approved there, and only while that pane is still running exactly it; a new
 * or different command never becomes executable through autosave.
 */
import type {Store} from 'redux';

import type {HyperState} from '../../typings/hyper';
import rpc from '../rpc';

import {serializeLayoutState} from './layout-serialize';
import {applyResumeSelections, filterLayoutToTab, resumeCandidatesForTab} from './workspace-tab';
import type {SerializedLayout} from './workspace-tab';

export type ApprovedResume = {sessionUid: string; command: string; source: 'n8' | 'shell'};

export type TabAutosave = {
  name: string;
  approved: ApprovedResume[];
  /** JSON of the last layout sent, so unchanged snapshots aren't re-saved. */
  lastSaved?: string;
};

export const AUTOSAVE_DEBOUNCE_MS = 2000;
/** Constant churn (an agent animating its title) must not postpone a save forever. */
export const AUTOSAVE_MAX_WAIT_MS = 10000;

/** Window event fired after an autosave write lands; detail: {rootUid}. The tab
 *  uses it for a brief pulse of its top line. */
export const TAB_AUTOSAVED_EVENT = 'hyperia-tab-autosaved';

const bindings = new Map<string, TabAutosave>();

export const getTabAutosave = (rootUid: string): TabAutosave | undefined => bindings.get(rootUid);

// Which saved names autosave, kept across restarts so restoring the saved tab
// re-binds it. The bindings themselves stay per-tab and in memory.
const AUTOSAVE_NAMES_KEY = 'hyperia.tabAutosaveNames';
const readNames = (): Record<string, true> => {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(AUTOSAVE_NAMES_KEY) || '{}') || {};
  } catch {
    return {};
  }
};
const writeNames = (names: Record<string, true>) => {
  try {
    globalThis.localStorage?.setItem(AUTOSAVE_NAMES_KEY, JSON.stringify(names));
  } catch {
    /* storage unavailable: autosave just won't survive a restore */
  }
};
export const isAutosaveName = (name: string): boolean => !!readNames()[name];

export const setTabAutosave = (rootUid: string, binding: TabAutosave): void => {
  // One writer per saved name: the newest binding wins.
  for (const [uid, b] of bindings) if (uid !== rootUid && b.name === binding.name) bindings.delete(uid);
  bindings.set(rootUid, binding);
  writeNames({...readNames(), [binding.name]: true});
};

export const clearTabAutosave = (rootUid: string): void => {
  const b = bindings.get(rootUid);
  bindings.delete(rootUid);
  if (b) {
    const names = readNames();
    delete names[b.name];
    writeNames(names);
  }
};

/** The saved tab is gone (deleted): end every binding to it and forget the name. */
export const forgetAutosaveName = (name: string): void => {
  for (const [uid, b] of bindings) if (b.name === name) bindings.delete(uid);
  const names = readNames();
  if (names[name]) {
    delete names[name];
    writeNames(names);
  }
};

/**
 * A saved tab was restored as `rootUid`: if that name autosaves, bind the new
 * tab, carrying the resume commands the human approved when it was saved.
 */
export const bindRestoredTab = (rootUid: string, name: string | undefined, layout: SerializedLayout): boolean => {
  if (!name || !isAutosaveName(name)) return false;
  const approved: ApprovedResume[] = [];
  for (const [sessionUid, sess] of Object.entries(layout.sessions || {})) {
    const r = sess?.resumeOnce;
    if (r?.command && (r.source === 'n8' || r.source === 'shell')) {
      approved.push({sessionUid, command: r.command, source: r.source});
    }
  }
  setTabAutosave(rootUid, {name, approved});
  return true;
};

/**
 * The layout autosave would write for one bound tab, or null when the tab is
 * gone. Approved commands are kept only where the pane's current candidate is
 * still that exact command.
 */
export const buildAutosaveLayout = (
  full: SerializedLayout,
  liveSessions: Record<string, any>,
  rootUid: string,
  approved: ApprovedResume[]
): SerializedLayout | null => {
  const tab = filterLayoutToTab(full, rootUid);
  if (!tab) {
    return null;
  }
  const current = resumeCandidatesForTab(tab, liveSessions);
  const still = approved.filter((a) =>
    current.some((c) => c.sessionUid === a.sessionUid && c.source === a.source && sameCommand(c.command, a.command))
  );
  return applyResumeSelections(tab, still);
};

/**
 * What autosave compares: only what restoring the tab would recreate. Titles,
 * focus, sizes, pids and typed command lines change constantly and restore none
 * of that, so they never trigger a write.
 */
export const autosaveSignature = (layout: SerializedLayout): string => {
  const sessions: Record<string, unknown> = {};
  for (const [uid, sess] of Object.entries(layout.sessions || {})) {
    sessions[uid] = {
      cwd: sess.cwd,
      profile: sess.profile,
      shellName: sess.shellName,
      tabName: sess.tabName,
      title: sess.manualTitle ? sess.title : undefined,
      container: sess.annotations?.container?.sessionId,
      resumeOnce: sess.resumeOnce
    };
  }
  return JSON.stringify({termGroups: layout.termGroups, sessions});
};

// n8 candidates carry the resume command with or without --danger depending on
// how the pane launched; the human may have flipped that toggle in the toast.
const sameCommand = (candidate: string, approved: string): boolean =>
  candidate === approved || stripDanger(candidate) === stripDanger(approved);

const stripDanger = (cmd: string) =>
  cmd
    .replace(/(^|\s)--danger(?=\s|$)/, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Watch the store and re-save bound tabs after changes settle. Returns a
 * disposer. Results come back on 'save tab workspace result' with
 * autosave: true, which the toast ignores.
 */
export const startTabAutosave = (
  store: Store<HyperState>,
  getCommandLine: (uid: string) => string | undefined,
  debounceMs = AUTOSAVE_DEBOUNCE_MS,
  maxWaitMs = AUTOSAVE_MAX_WAIT_MS
): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // When the current burst of changes began; the timer stops sliding after maxWaitMs.
  let burstStart = 0;
  let seenGroups: unknown = null;
  let seenSessions: unknown = null;
  // Saved name -> tab, so a result (which carries only the name) finds its tab.
  const inFlight = new Map<string, string>();

  const flush = () => {
    timer = null;
    burstStart = 0;
    if (bindings.size === 0) {
      return;
    }
    const state = store.getState();
    const full = serializeLayoutState(state, getCommandLine) as SerializedLayout;
    for (const [rootUid, binding] of bindings) {
      const layout = buildAutosaveLayout(full, state.sessions.sessions as any, rootUid, binding.approved);
      if (!layout) {
        // Tab closed: the binding ends with it.
        bindings.delete(rootUid);
        continue;
      }
      const sig = autosaveSignature(layout);
      if (sig === binding.lastSaved) {
        continue;
      }
      binding.lastSaved = sig;
      inFlight.set(binding.name, rootUid);
      rpc.emit('save tab workspace', {name: binding.name, overwrite: true, layout, autosave: true});
    }
  };

  const unsubscribe = store.subscribe(() => {
    if (bindings.size === 0) {
      return;
    }
    const {termGroups, sessions} = store.getState();
    if (termGroups === seenGroups && sessions === seenSessions) {
      return;
    }
    seenGroups = termGroups;
    seenSessions = sessions;
    const now = Date.now();
    if (!timer) {
      burstStart = now;
    } else if (now - burstStart < maxWaitMs) {
      clearTimeout(timer);
    } else {
      return; // max wait reached: let the pending flush fire
    }
    timer = setTimeout(flush, debounceMs);
  });

  // The saved-tab library came back: a name missing from it was deleted.
  const onList = ({rows}: {rows?: Array<{name: string}>}) => {
    if (!Array.isArray(rows)) return;
    const present = new Set(rows.map((r) => r.name));
    const names = new Set([...bindings.values()].map((b) => b.name));
    for (const n of Object.keys(readNames())) names.add(n);
    for (const n of names) if (!present.has(n)) forgetAutosaveName(n);
  };
  rpc.on('tab workspaces list', onList);

  const onResult = (res: {ok: boolean; name: string; error?: string; autosave?: boolean}) => {
    if (!res.autosave) {
      return;
    }
    const rootUid = inFlight.get(res.name);
    inFlight.delete(res.name);
    if (res.ok) {
      if (rootUid && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(TAB_AUTOSAVED_EVENT, {detail: {rootUid}}));
      }
      return;
    }
    console.warn(`[workspace] autosave of tab '${res.name}' failed:`, res.error);
    // Forget the snapshot so the next change retries the write.
    for (const b of bindings.values()) {
      if (b.name === res.name) b.lastSaved = undefined;
    }
  };
  rpc.on('save tab workspace result', onResult);

  return () => {
    unsubscribe();
    rpc.removeListener('save tab workspace result', onResult);
    rpc.removeListener('tab workspaces list', onList);
    if (timer) {
      clearTimeout(timer);
    }
  };
};
