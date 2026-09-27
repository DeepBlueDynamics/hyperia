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

const bindings = new Map<string, TabAutosave>();

export const getTabAutosave = (rootUid: string): TabAutosave | undefined => bindings.get(rootUid);

export const setTabAutosave = (rootUid: string, binding: TabAutosave): void => {
  bindings.set(rootUid, binding);
};

export const clearTabAutosave = (rootUid: string): void => {
  bindings.delete(rootUid);
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
  debounceMs = AUTOSAVE_DEBOUNCE_MS
): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seenGroups: unknown = null;
  let seenSessions: unknown = null;

  const flush = () => {
    timer = null;
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
      const json = JSON.stringify(layout);
      if (json === binding.lastSaved) {
        continue;
      }
      binding.lastSaved = json;
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
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, debounceMs);
  });

  const onResult = (res: {ok: boolean; name: string; error?: string; autosave?: boolean}) => {
    if (res.autosave && !res.ok) {
      console.warn(`[workspace] autosave of tab '${res.name}' failed:`, res.error);
      // Forget the snapshot so the next change retries the write.
      for (const b of bindings.values()) {
        if (b.name === res.name) b.lastSaved = undefined;
      }
    }
  };
  rpc.on('save tab workspace result', onResult);

  return () => {
    unsubscribe();
    rpc.removeListener('save tab workspace result', onResult);
    if (timer) {
      clearTimeout(timer);
    }
  };
};
