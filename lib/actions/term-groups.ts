import {SESSION_REQUEST} from '../../typings/constants/sessions';
import {
  DIRECTION,
  TERM_GROUP_RESIZE,
  TERM_GROUP_REQUEST,
  TERM_GROUP_EXIT,
  TERM_GROUP_EXIT_ACTIVE,
  TERM_GROUP_SET_WEB_URL,
  TERM_GROUP_ADD_WEB_TAB,
  TERM_GROUP_ACTIVATE_WEB_TAB,
  RESTORE_LAYOUT_STATE,
  TERM_GROUP_POP_OUT_PANE
} from '../../typings/constants/term-groups';
import type {ITermState, ITermGroup, HyperState, HyperDispatch, HyperActions} from '../../typings/hyper';
import rpc from '../rpc';
import {getRootGroups} from '../selectors';
import findBySession, {countPathHorizontalStacks} from '../utils/term-groups';

import {setActiveSession, ptyExitSession, userExitSession} from './sessions';

function requestSplit(direction: 'VERTICAL' | 'HORIZONTAL') {
  return (_activeUid: string | undefined, _profile: string | undefined, url?: string, splitPlacement?: 'BEFORE' | 'AFTER', isAgentInitiated?: boolean) =>
    (dispatch: HyperDispatch, getState: () => HyperState): void => {
      const {sessions, termGroups} = getState();
      let activeUid = _activeUid;
      if (!activeUid) {
        if (termGroups.activeTermGroup) {
          activeUid = termGroups.activeTermGroup;
        } else if (termGroups.activeRootGroup) {
          activeUid = termGroups.activeSessions[termGroups.activeRootGroup] || termGroups.activeRootGroup || undefined;
        } else {
          activeUid = sessions.activeUid || undefined;
        }
      }

      if (direction === 'HORIZONTAL' && activeUid) {
        let activeGroup = findBySession(termGroups, activeUid);
        if (!activeGroup && termGroups.termGroups[activeUid]) {
          activeGroup = termGroups.termGroups[activeUid];
        }
        if (activeGroup) {
          const stacks = countPathHorizontalStacks(activeGroup.uid, termGroups.termGroups);
          if (stacks >= 11) {
            return;
          }
        }
      }
      dispatch({
        type: SESSION_REQUEST,
        effect: () => {
          const {ui, sessions, termGroups} = getState();
          let activeUid = _activeUid;
          if (!activeUid) {
            if (termGroups.activeTermGroup) {
              activeUid = termGroups.activeTermGroup;
            } else if (termGroups.activeRootGroup) {
              activeUid =
                termGroups.activeSessions[termGroups.activeRootGroup] || termGroups.activeRootGroup || undefined;
            } else {
              activeUid = sessions.activeUid || undefined;
            }
          }
          const activeSession = activeUid ? sessions.sessions[activeUid] : null;
          const cwd = (activeSession && activeSession.cwd) || ui.cwd;
          // UI-initiated splits ALWAYS show the pane-type PICKER — you pick what
          // goes in the new pane (both directions, any source). An explicit
          // `_profile` still wins: agent terminal_split passes a real profile so
          // it lands on a PTY, the AI split passes 'Web Pane', etc.
          const profile = _profile ? _profile : 'picker';
          rpc.emit('new', {
            splitDirection: direction,
            cwd,
            activeUid,
            profile,
            url,
            splitPlacement,
            isAgentInitiated
          });
        }
      });
    };
}

export const requestVerticalSplit = requestSplit(DIRECTION.VERTICAL);
export const requestHorizontalSplit = requestSplit(DIRECTION.HORIZONTAL);

export function resizeTermGroup(uid: string, sizes: number[]): HyperActions {
  return {
    uid,
    type: TERM_GROUP_RESIZE,
    sizes
  };
}

export function requestTermGroup(_activeUid: string | undefined, _profile: string | undefined, isAgentInitiated?: boolean) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    dispatch({
      type: TERM_GROUP_REQUEST,
      effect: () => {
        const {ui, sessions} = getState();
        const activeUid = _activeUid ? _activeUid : sessions.activeUid;
        const activeSession = activeUid && sessions.sessions[activeUid] ? sessions.sessions[activeUid] : null;
        const cwd = (activeSession && activeSession.cwd) || ui.cwd;
        const profile = _profile ? _profile : activeSession ? activeSession.profile : window.profileName || 'default';
        rpc.emit('new', {
          isNewGroup: true,
          cwd,
          activeUid,
          profile,
          isAgentInitiated
        });
      }
    });
  };
}

export function setActiveGroup(uid: string) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const {termGroups} = getState();
    const sessionUid = termGroups.activeSessions[uid];
    // Only trust the remembered active session if it STILL resolves to a node in
    // the tree. A dangling pointer (its pane was closed or the layout desynced)
    // would otherwise be dispatched and crash the reducer's findBySession,
    // bricking the tab so it can't be selected. When it's stale, fall through to
    // re-deriving a live pane below.
    if (sessionUid && findBySession(termGroups, sessionUid)) {
      dispatch(setActiveSession(sessionUid));
      return;
    }
    const group = termGroups.termGroups[uid];
    if (group) {
      const leaves = findLeaves(termGroups, group);
      // Prefer a leaf with a live, resolvable session so the tab always lands on
      // something real even when the tree is partly corrupt.
      const liveLeaf = leaves.find((l) => l.sessionUid && findBySession(termGroups, l.sessionUid));
      if (liveLeaf && liveLeaf.sessionUid) {
        dispatch(setActiveSession(liveLeaf.sessionUid));
        return;
      }
      const firstLeaf = leaves[0];
      if (firstLeaf) {
        if (firstLeaf.sessionUid) {
          dispatch(setActiveSession(firstLeaf.sessionUid));
        } else {
          dispatch({type: 'TERM_GROUP_SET_ACTIVE', uid: firstLeaf.uid} as any);
        }
        return;
      }
    }
    // Fallback (web-only / empty tab)
    dispatch({type: TERM_GROUP_ACTIVATE_WEB_TAB, uid} as any);
  };
}

// Helper to find all leaf groups (panes) under a group recursively
const findLeaves = (state: ITermState, group: ITermGroup): ITermGroup[] => {
  if (!group.children || group.children.length === 0) {
    return [group];
  }
  const leaves: ITermGroup[] = [];
  for (const childUid of group.children.asMutable()) {
    const child = state.termGroups[childUid];
    if (child) {
      leaves.push(...findLeaves(state, child));
    }
  }
  return leaves;
};

const findPrevious = <T>(list: T[], old: T) => {
  const index = list.indexOf(old);
  // If `old` was the first item in the list,
  // choose the other item available:
  return index ? list[index - 1] : list[1];
};

// Find the next pane's UID (either session pane or web pane) when a pane is closed
const findNextPaneUid = (state: ITermState, group: ITermGroup): string | undefined => {
  if (!group.parentUid) {
    const rootGroups = getRootGroups({termGroups: state});
    const nextGroup = findPrevious(rootGroups, group);
    if (!nextGroup) return undefined;
    const leaves = findLeaves(state, nextGroup);
    return leaves[0]?.uid;
  }

  const {children} = state.termGroups[group.parentUid];
  const nextUid = findPrevious(children.asMutable(), group.uid);
  const nextGroup = state.termGroups[nextUid];
  if (!nextGroup) return undefined;
  const leaves = findLeaves(state, nextGroup);
  return leaves[0]?.uid;
};

export function ptyExitTermGroup(sessionUid: string) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const {termGroups} = getState();
    const group = findBySession(termGroups, sessionUid);
    // This might have already been closed:
    if (!group) {
      return dispatch(ptyExitSession(sessionUid));
    }

    dispatch({
      type: TERM_GROUP_EXIT,
      uid: group.uid,
      effect: () => {
        const stateAfterExit = getState();
        const termGroupsAfterExit = stateAfterExit.termGroups;
        const activeSessionUid = termGroups.activeSessions[termGroups.activeRootGroup!];
        const isFocused = termGroups.activeTermGroup === group.uid || activeSessionUid === sessionUid;

        if (Object.keys(termGroupsAfterExit.termGroups).length > 0 && isFocused) {
          const nextPaneUid = findNextPaneUid(termGroups, group);
          if (nextPaneUid && termGroupsAfterExit.termGroups[nextPaneUid]) {
            const nextPane = termGroupsAfterExit.termGroups[nextPaneUid];
            if (nextPane.sessionUid) {
              dispatch(setActiveSession(nextPane.sessionUid));
            } else {
              dispatch({type: 'TERM_GROUP_SET_ACTIVE', uid: nextPaneUid} as any);
            }
          }
        }

        dispatch(ptyExitSession(sessionUid));
      }
    });
  };
}

export function userExitTermGroup(uid: string) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const {termGroups} = getState();
    dispatch({
      type: TERM_GROUP_EXIT,
      uid,
      effect: () => {
        const group = termGroups.termGroups[uid];
        if (!group) return;
        if (Object.keys(termGroups.termGroups).length <= 1) {
          // Last group — exit the session if there is one, and close the window immediately
          if (group.sessionUid) {
            dispatch(userExitSession(group.sessionUid));
          }
          window.close();
          return;
        }

        const activeSessionUid = termGroups.activeSessions[termGroups.activeRootGroup!];
        const isActive =
          termGroups.activeRootGroup === uid ||
          activeSessionUid === group.sessionUid ||
          termGroups.activeTermGroup === uid;

        if (isActive) {
          const nextPaneUid = findNextPaneUid(termGroups, group);
          if (nextPaneUid) {
            const stateAfterExit = getState();
            const termGroupsAfterExit = stateAfterExit.termGroups;
            if (termGroupsAfterExit.termGroups[nextPaneUid]) {
              const nextPane = termGroupsAfterExit.termGroups[nextPaneUid];
              if (nextPane.sessionUid) {
                dispatch(setActiveSession(nextPane.sessionUid));
              } else {
                dispatch({type: 'TERM_GROUP_SET_ACTIVE', uid: nextPaneUid} as any);
              }
            }
          }
        }

        if (group.sessionUid) {
          dispatch(userExitSession(group.sessionUid));
        } else if (group.children && group.children.length > 0) {
          group.children.forEach((childUid) => {
            dispatch(userExitTermGroup(childUid));
          });
        }
        // Web pane root tab with no children: TERM_GROUP_EXIT already removes the group
      }
    });
  };
}

export function setWebPane(url: string | null) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const {sessions, termGroups} = getState();
    const group = findBySession(termGroups, sessions.activeUid!);
    if (!group) return;
    dispatch({type: TERM_GROUP_SET_WEB_URL, uid: group.uid, url} as any);
  };
}

export function clearWebPane(groupUid: string) {
  return (dispatch: HyperDispatch) => {
    dispatch({type: TERM_GROUP_SET_WEB_URL, uid: groupUid, url: null} as any);
  };
}

export function openWebPaneInNewTab(url: string, name?: string) {
  return (dispatch: HyperDispatch) => {
    dispatch({type: TERM_GROUP_ADD_WEB_TAB, url, name} as any);
  };
}

// Split the active pane and open `url` in a new WEB PANE below it (no shell,
// no session) — for target="_blank" links in a web pane.
export function splitWebPaneBelow(activeUid: string | undefined, url: string) {
  return (dispatch: HyperDispatch) => {
    dispatch({type: 'TERM_GROUP_SPLIT_WEB', activeUid, url, splitDirection: 'HORIZONTAL'} as any);
  };
}

export function splitWebPane(activeUid: string | undefined, url: string, direction: 'HORIZONTAL' | 'VERTICAL', isAgentInitiated?: boolean) {
  return (dispatch: HyperDispatch) => {
    dispatch({type: 'TERM_GROUP_SPLIT_WEB', activeUid, url, splitDirection: direction, isAgentInitiated} as any);
  };
}

export function exitActiveTermGroup() {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    dispatch({
      type: TERM_GROUP_EXIT_ACTIVE,
      effect() {
        const {sessions, termGroups} = getState();
        const activeUid =
          termGroups.activeTermGroup ||
          (sessions.activeUid ? findBySession(termGroups, sessions.activeUid)?.uid : null);
        if (activeUid) {
          dispatch(userExitTermGroup(activeUid));
        }
      }
    });
  };
}

export function restoreLayoutState(savedState: any) {
  return (dispatch: HyperDispatch) => {
    dispatch({
      type: RESTORE_LAYOUT_STATE,
      savedState
    });

    if (savedState.sessions) {
      Object.keys(savedState.sessions).forEach((uid) => {
        const session = savedState.sessions[uid];
        if (session && !session.url) {
          rpc.emit('new', {
            uid,
            cwd: session.cwd,
            profile: session.profile,
            isRestore: true,
            lastCommand: session.lastCommand
          });
        }
      });
    }
  };
}

export function popOutPane(uid: string) {
  return (dispatch: HyperDispatch) => {
    dispatch({
      type: TERM_GROUP_POP_OUT_PANE,
      uid
    } as any);
  };
}
