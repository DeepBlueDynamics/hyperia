/**
 * The workspace layout serializer — the single source of the layout blob
 * shape (docs/workspace-format.md). Extracted from the get-layout-state-req
 * handler so tab-scoped capture (#183, the save toast) reuses the identical
 * serialization instead of drifting its own.
 */
import type {HyperState} from '../../typings/hyper';

export const serializeLayoutState = (
  state: Pick<HyperState, 'termGroups' | 'sessions'>,
  getCommandLine: (uid: string) => string | undefined
): Record<string, any> => {
  const {termGroups, sessions} = state;

  const serializedSessions: Record<string, any> = {};
  Object.keys(sessions.sessions).forEach((uid) => {
    const s = sessions.sessions[uid];
    if (s) {
      const lastCommand = getCommandLine(uid) || s.lastCommand || '';
      const n8 = (s as any).n8Binding;
      // annotations are DISPLAY-ONLY by the workspace safety model. The
      // executable resumeOnce field is stamped separately, only from the
      // save toast's human-checked selections (utils/workspace-tab.ts).
      const annotations: Record<string, any> = {};
      if (lastCommand) annotations.lastCommand = lastCommand;
      if (n8) annotations.container = n8;
      serializedSessions[uid] = {
        uid: s.uid,
        title: s.title,
        tabName: s.tabName,
        description: s.description,
        cols: s.cols,
        rows: s.rows,
        shell: s.shell,
        pid: s.pid,
        profile: s.profile,
        cwd: s.cwd,
        shellName: s.shellName,
        manualTitle: !!s.manualTitle,
        annotations: Object.keys(annotations).length > 0 ? annotations : undefined
      };
    }
  });

  const serializedTermGroups: Record<string, any> = {};
  Object.keys(termGroups.termGroups).forEach((uid) => {
    const g = termGroups.termGroups[uid];
    if (g) {
      serializedTermGroups[uid] = {
        uid: g.uid,
        sessionUid: g.sessionUid,
        parentUid: g.parentUid,
        direction: g.direction,
        sizes: g.sizes,
        children: g.children ? (g.children as any).asMutable() : [],
        webUrl: (g as any).webUrl,
        webName: (g as any).webName,
        tabName: g.tabName,
        manualTabName: !!(g as any).manualTabName,
        pinned: (g as any).pinned
      };
    }
  });

  return {
    activeUid: sessions.activeUid,
    activeRootGroup: termGroups.activeRootGroup,
    activeTermGroup: termGroups.activeTermGroup || null,
    activeSessions: termGroups.activeSessions ? (termGroups.activeSessions as any).asMutable() : {},
    termGroups: serializedTermGroups,
    sessions: serializedSessions
  };
};
