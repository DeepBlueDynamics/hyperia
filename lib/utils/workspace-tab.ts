/**
 * Tab-scoped workspace helpers (#183).
 *
 * A tab-workspace is the shipped workspace format narrowed to ONE root term
 * group and its subtree. These are pure functions over the serialized layout
 * blob (the shape `get-layout-state-req` emits), kept dependency-free so ava
 * can exercise them directly.
 */

export type SerializedLayout = {
  activeUid?: string | null;
  activeRootGroup?: string | null;
  activeTermGroup?: string | null;
  activeSessions?: Record<string, string | null>;
  termGroups: Record<string, any>;
  sessions: Record<string, any>;
};

/**
 * Narrow a full-window layout to one tab: the root group, every descendant
 * group, and only the sessions those groups reference. Active pointers are
 * scoped to the tab (activeRootGroup = the tab; activeTermGroup/activeUid only
 * if they live inside it, else the tab's recorded active session).
 * Returns null when the root group doesn't exist or isn't a root.
 */
export const filterLayoutToTab = (layout: SerializedLayout, rootUid: string): SerializedLayout | null => {
  const src = layout.termGroups || {};
  const root = src[rootUid];
  if (!root || root.parentUid) {
    return null;
  }
  const termGroups: Record<string, any> = {};
  const queue = [rootUid];
  while (queue.length > 0) {
    const uid = queue.shift()!;
    const g = src[uid];
    if (!g || termGroups[uid]) {
      continue;
    }
    termGroups[uid] = g;
    for (const child of g.children || []) {
      queue.push(child);
    }
  }
  const sessions: Record<string, any> = {};
  for (const g of Object.values(termGroups)) {
    if (g.sessionUid && layout.sessions?.[g.sessionUid]) {
      sessions[g.sessionUid] = layout.sessions[g.sessionUid];
    }
  }
  const tabActiveSession = layout.activeSessions?.[rootUid] ?? null;
  const activeTermGroup =
    layout.activeTermGroup && termGroups[layout.activeTermGroup] ? layout.activeTermGroup : rootUid;
  const activeUid = layout.activeUid && sessions[layout.activeUid] ? layout.activeUid : tabActiveSession;
  return {
    activeUid,
    activeRootGroup: rootUid,
    activeTermGroup,
    activeSessions: {[rootUid]: tabActiveSession},
    termGroups,
    sessions
  };
};

export type ResumeCandidate = {
  sessionUid: string;
  /** The command that would re-run on restore. */
  command: string;
  /** Where it came from — only trustworthy sources are ever executable. */
  source: 'n8' | 'shell';
  /** Pre-check n8 resumes in the save toast; shell commands are opt-in. */
  preChecked: boolean;
  /** Pane label for the toast row. */
  label: string;
};

/**
 * Executable resume-once candidates for a tab's sessions. THE safety rule
 * (#183, settled): commands come only from the n8 session binding (OSC-777)
 * or the shell-integration-REPORTED command of a pane that was busy at save.
 * The screen-scraped annotations.lastCommand is never offered for execution.
 */
export const resumeCandidatesForTab = (
  tabLayout: SerializedLayout,
  liveSessions: Record<string, any>
): ResumeCandidate[] => {
  const out: ResumeCandidate[] = [];
  for (const uid of Object.keys(tabLayout.sessions || {})) {
    const live = liveSessions[uid];
    if (!live) {
      continue;
    }
    const label = live.shellName || live.tabName || live.title || uid.slice(0, 8);
    if (live.n8Binding?.resume) {
      out.push({sessionUid: uid, command: live.n8Binding.resume, source: 'n8', preChecked: true, label});
      continue;
    }
    const reported = live.shellState?.command;
    const wasRunning = live.busy || live.shellState?.state === 'busy';
    if (reported && wasRunning) {
      out.push({sessionUid: uid, command: reported, source: 'shell', preChecked: false, label});
    }
  }
  return out;
};

/**
 * Stamp the human's save-toast choices into the tab layout: checked
 * candidates become `resumeOnce` on their session — the ONLY field restore
 * ever executes (annotations stay display-only).
 */
export const applyResumeSelections = (
  tabLayout: SerializedLayout,
  selections: Array<{sessionUid: string; command: string; source: 'n8' | 'shell'}>
): SerializedLayout => {
  const sessions = {...tabLayout.sessions};
  for (const sel of selections) {
    if (sessions[sel.sessionUid]) {
      sessions[sel.sessionUid] = {
        ...sessions[sel.sessionUid],
        resumeOnce: {command: sel.command, source: sel.source}
      };
    }
  }
  return {...tabLayout, sessions};
};
