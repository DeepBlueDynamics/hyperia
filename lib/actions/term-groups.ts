import {SESSION_REQUEST} from '../../typings/constants/sessions';
import {
  DIRECTION,
  TERM_GROUP_RESIZE,
  TERM_GROUP_REQUEST,
  TERM_GROUP_EXIT,
  TERM_GROUP_EXIT_ACTIVE,
  TERM_GROUP_SET_WEB_URL,
  TERM_GROUP_ADD_WEB_TAB,
  TERM_GROUP_ACTIVATE_WEB_TAB
} from '../../typings/constants/term-groups';
import type {ITermState, ITermGroup, HyperState, HyperDispatch, HyperActions} from '../../typings/hyper';
import rpc from '../rpc';
import {getRootGroups} from '../selectors';
import findBySession from '../utils/term-groups';

import {setActiveSession, ptyExitSession, userExitSession} from './sessions';

function requestSplit(direction: 'VERTICAL' | 'HORIZONTAL') {
  return (_activeUid: string | undefined, _profile: string | undefined, url?: string) =>
    (dispatch: HyperDispatch, getState: () => HyperState): void => {
      dispatch({
        type: SESSION_REQUEST,
        effect: () => {
          const {ui, sessions} = getState();
          const activeUid = _activeUid ? _activeUid : sessions.activeUid;
          const activeSession = activeUid ? sessions.sessions[activeUid] : null;
          const cwd = (activeSession && activeSession.cwd) || ui.cwd;
          const profile = _profile ? _profile : 'picker';
          rpc.emit('new', {
            splitDirection: direction,
            cwd,
            activeUid,
            profile,
            url
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

export function requestTermGroup(_activeUid: string | undefined, _profile: string | undefined) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    dispatch({
      type: TERM_GROUP_REQUEST,
      effect: () => {
        const {ui, sessions} = getState();
        const activeUid = _activeUid ? _activeUid : sessions.activeUid;
        const activeSession = activeUid ? sessions.sessions[activeUid] : null;
        const cwd = (activeSession && activeSession.cwd) || ui.cwd;
        const profile = _profile ? _profile : activeUid ? sessions.sessions[activeUid].profile : window.profileName;
        rpc.emit('new', {
          isNewGroup: true,
          cwd,
          activeUid,
          profile
        });
      }
    });
  };
}

export function setActiveGroup(uid: string) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const {termGroups} = getState();
    const sessionUid = termGroups.activeSessions[uid];
    if (sessionUid) {
      dispatch(setActiveSession(sessionUid));
    } else {
      // Web pane tab — no session, just set the active root group
      dispatch({type: TERM_GROUP_ACTIVATE_WEB_TAB, uid} as any);
    }
  };
}

// When we've found the next group which we want to
// set as active (after closing something), we also need
// to find the first child group which has a sessionUid.
const findFirstSession = (state: ITermState, group: ITermGroup): string | undefined => {
  if (group.sessionUid) {
    return group.sessionUid;
  }

  for (const childUid of group.children.asMutable()) {
    const child = state.termGroups[childUid];
    // We want to find the *leftmost* session,
    // even if it's nested deep down:
    const sessionUid = findFirstSession(state, child);
    if (sessionUid) {
      return sessionUid;
    }
  }
};

const findPrevious = <T>(list: T[], old: T) => {
  const index = list.indexOf(old);
  // If `old` was the first item in the list,
  // choose the other item available:
  return index ? list[index - 1] : list[1];
};

const findNextSessionUid = (state: ITermState, group: ITermGroup) => {
  // If we're closing a root group (i.e. a whole tab),
  // the next group needs to be a root group as well:
  if (state.activeRootGroup === group.uid) {
    const rootGroups = getRootGroups({termGroups: state});
    const nextGroup = findPrevious(rootGroups, group);
    return findFirstSession(state, nextGroup);
  }

  const {children} = state.termGroups[group.parentUid!];
  const nextUid = findPrevious(children.asMutable(), group.uid);
  return findFirstSession(state, state.termGroups[nextUid]);
};

export function ptyExitTermGroup(sessionUid: string) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const {termGroups} = getState();
    const group = findBySession(termGroups, sessionUid);
    // This might have already been closed:
    if (!group) {
      return dispatch(ptyExitSession(sessionUid));
    }

    if ((group as any).isSwitching) {
      return dispatch(ptyExitSession(sessionUid));
    }

    dispatch({
      type: TERM_GROUP_EXIT,
      uid: group.uid,
      effect: () => {
        const activeSessionUid = termGroups.activeSessions[termGroups.activeRootGroup!];
        if (Object.keys(termGroups.termGroups).length > 1 && activeSessionUid === sessionUid) {
          const nextSessionUid = findNextSessionUid(termGroups, group);
          dispatch(setActiveSession(nextSessionUid!));
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
        if (Object.keys(termGroups.termGroups).length <= 1) {
          // Last group — exit the session if there is one, otherwise close the window
          if (group.sessionUid) {
            dispatch(userExitSession(group.sessionUid));
          } else {
            window.close();
          }
          return;
        }

        const activeSessionUid = termGroups.activeSessions[termGroups.activeRootGroup!];
        const isActive = termGroups.activeRootGroup === uid || activeSessionUid === group.sessionUid;

        if (isActive) {
          // Try to find the next session the normal way first
          const nextSessionUid = group.sessionUid ? findNextSessionUid(termGroups, group) : undefined;
          if (nextSessionUid) {
            dispatch(setActiveSession(nextSessionUid));
          } else {
            // Next tab may be a web pane — find the previous root group directly
            const rootGroups = getRootGroups({termGroups});
            const nextGroup = findPrevious(rootGroups, group);
            if (nextGroup) {
              const nextSession = termGroups.activeSessions[nextGroup.uid];
              if (nextSession) {
                dispatch(setActiveSession(nextSession));
              } else {
                dispatch({type: TERM_GROUP_ACTIVATE_WEB_TAB, uid: nextGroup.uid} as any);
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

// Switch a pane to a different shell in place. The old session is completely terminated,
// and a brand new clean terminal session is spawned in that same layout pane/group,
// which fully unmounts the old xterm and mounts a fresh one.
export function switchPaneProfile(groupUid: string, sessionUid: string | undefined, profileName: string) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    dispatch({ type: 'TERM_GROUP_PREPARE_SWITCH', uid: groupUid } as any);
    dispatch({ type: TERM_GROUP_SET_WEB_URL, uid: groupUid, url: null } as any);

    let cwd;
    if (sessionUid) {
      const { sessions, ui } = getState();
      const activeSession = sessions.sessions[sessionUid];
      cwd = (activeSession && activeSession.cwd) || ui.cwd;

      rpc.emit('exit', { uid: sessionUid });
      dispatch({ type: 'SESSION_USER_EXIT', uid: sessionUid, effect: () => {} } as any);
    } else {
      cwd = getState().ui.cwd;
    }

    rpc.emit('new', {
      isNewGroup: false,
      cwd,
      activeUid: sessionUid,
      profile: profileName,
      groupUid
    });
  };
}

// Switch a pane to a web view. The old session is completely terminated,
// and we clear the group's sessionUid, letting the Web Pane take up the entire pane.
export function switchPaneToWeb(groupUid: string, sessionUid: string | undefined, url: string = '') {
  return (dispatch: HyperDispatch) => {
    if (sessionUid) {
      rpc.emit('exit', { uid: sessionUid });
      dispatch({ type: 'SESSION_USER_EXIT', uid: sessionUid, effect: () => {} } as any);
    }
    dispatch({ type: TERM_GROUP_SET_WEB_URL, uid: groupUid, url } as any);
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

export function openWebPaneInNewTab(url: string) {
  return (dispatch: HyperDispatch) => {
    dispatch({type: TERM_GROUP_ADD_WEB_TAB, url} as any);
  };
}

export function exitActiveTermGroup() {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    dispatch({
      type: TERM_GROUP_EXIT_ACTIVE,
      effect() {
        const {sessions, termGroups} = getState();
        const {uid} = findBySession(termGroups, sessions.activeUid!)!;
        dispatch(userExitTermGroup(uid));
      }
    });
  };
}
