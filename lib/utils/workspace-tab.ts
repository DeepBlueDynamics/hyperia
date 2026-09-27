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
  /** Pre-checked in the save toast: n8 resumes and the shell-reported
   *  foreground command alike — what was running is what you expect back.
   *  The human sees every row and can untick it. */
  preChecked: boolean;
  /** Pane label for the toast row. */
  label: string;
  /** n8 only: initial state of the row's danger toggle (was it launched with --danger?). */
  danger?: boolean;
};

const DANGER_FLAG = /(^|\s)--danger(?=\s|$)/;

/** Did this n8 pane start in danger mode? The resume binding doesn't say, so read
 *  the shell-reported launch command or the "nemesis8 danger" profile. */
export const launchedWithDanger = (live: any): boolean =>
  DANGER_FLAG.test(reportedCommand(live) || '') || /danger/i.test(String(live?.profile || ''));

/** `n8 resume <id>` with --danger added or removed per the toast toggle. */
export const n8ResumeCommand = (resume: string, danger: boolean): string => {
  const base = resume.replace(DANGER_FLAG, '$1').replace(/\s+/g, ' ').trim();
  return danger ? base.replace(/^(n8(?:\.exe)?\s+resume)\b/, '$1 --danger') : base;
};

/**
 * Executable resume-once candidates for a tab's sessions. THE safety rule
 * (#183, settled): commands come only from the n8 session binding (OSC-777)
 * or the shell-integration-REPORTED command of a pane that was busy at save.
 * The screen-scraped annotations.lastCommand is never offered for execution.
 *
 * The reported command is what preexec announced (OSC 697): `vim notes.md`,
 * `nano /tmp/x`, `npm run dev` — with its arguments, relative to the pane's
 * cwd, which restore recreates first. Main mirrors it as shellState.command
 * (and shellState.app.cmdline); both are read so an older main still works.
 */
export const reportedCommand = (live: any): string | undefined => {
  const st = live?.shellState;
  const cmd = st?.command || st?.app?.cmdline;
  return typeof cmd === 'string' && cmd.trim() ? cmd.trim() : undefined;
};

export const wasRunning = (live: any): boolean => {
  const st = live?.shellState?.state;
  // Main reports 'running'; the renderer's older typings said 'busy'; Term's
  // published busy flag folds in alt-screen detection. Any of them counts.
  return !!live?.busy || st === 'running' || st === 'busy';
};

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
      const danger = launchedWithDanger(live);
      out.push({
        sessionUid: uid,
        command: n8ResumeCommand(live.n8Binding.resume, danger),
        source: 'n8',
        preChecked: true,
        label,
        danger
      });
      continue;
    }
    const reported = reportedCommand(live);
    if (reported && wasRunning(live)) {
      out.push({sessionUid: uid, command: reported, source: 'shell', preChecked: true, label});
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
