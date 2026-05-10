import type {Session} from '../../typings/common';
import {
  SESSION_ADD,
  SESSION_RESIZE,
  SESSION_REQUEST,
  SESSION_ADD_DATA,
  SESSION_PTY_DATA,
  SESSION_PTY_EXIT,
  SESSION_USER_EXIT,
  SESSION_SET_ACTIVE,
  SESSION_CLEAR_ACTIVE,
  SESSION_USER_DATA,
  SESSION_SET_TAB_NAME,
  SESSION_SET_XTERM_TITLE,
  SESSION_SEARCH,
  SESSION_SET_DESCRIPTION
} from '../../typings/constants/sessions';
import {TERM_GROUP_SET_TAB_NAME} from '../../typings/constants/term-groups';
import type {HyperState, HyperDispatch, HyperActions} from '../../typings/hyper';
import rpc from '../rpc';
import {keys} from '../utils/object';
import findBySession from '../utils/term-groups';

export function addSession({uid, shell, pid, cols = null, rows = null, splitDirection, activeUid, profile}: Session) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const {sessions} = getState();
    const resolvedActiveUid = activeUid ? activeUid : sessions.activeUid;
    const now = Date.now();
    dispatch({
      type: SESSION_ADD,
      uid,
      shell,
      pid,
      cols,
      rows,
      splitDirection,
      activeUid: resolvedActiveUid,
      now,
      profile
    });
    // Keep split panes attached to the parent tab's existing name when syncing
    // the tab label back to the main process / sidecar.
    const newSession = getState().sessions.sessions[uid];
    const parentSession = resolvedActiveUid ? getState().sessions.sessions[resolvedActiveUid] : undefined;
    const tabName =
      splitDirection && parentSession
        ? parentSession.description || parentSession.tabName || parentSession.title
        : newSession?.tabName;
    if (tabName) {
      window.rpc.emit('session set tab name', {uid, tabName});
    }
    window.rpc.emit('session set active', {uid});
  };
}

export function requestSession(profile: string | undefined) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    dispatch({
      type: SESSION_REQUEST,
      effect: () => {
        const {ui} = getState();
        const {cwd} = ui;
        rpc.emit('new', {cwd, profile});
      }
    });
  };
}

export function addSessionData(uid: string, data: string) {
  return (dispatch: HyperDispatch) => {
    dispatch({
      type: SESSION_ADD_DATA,
      data,
      effect() {
        const now = Date.now();
        dispatch({
          type: SESSION_PTY_DATA,
          uid,
          data,
          now
        });
      }
    });
  };
}

function createExitAction(type: typeof SESSION_USER_EXIT | typeof SESSION_PTY_EXIT) {
  return (uid: string) => (dispatch: HyperDispatch, getState: () => HyperState) => {
    return dispatch({
      type,
      uid,
      effect() {
        if (type === SESSION_USER_EXIT) {
          rpc.emit('exit', {uid});
        }

        const sessions = keys(getState().sessions.sessions);
        if (sessions.length === 0) {
          window.close();
        }
      }
    } as HyperActions);
  };
}

// we want to distinguish an exit
// that's UI initiated vs pty initiated
export const userExitSession = createExitAction(SESSION_USER_EXIT);
export const ptyExitSession = createExitAction(SESSION_PTY_EXIT);

export function setActiveSession(uid: string) {
  return (dispatch: HyperDispatch) => {
    dispatch({
      type: SESSION_SET_ACTIVE,
      uid,
      effect() {
        window.rpc.emit('session set active', {uid});
      }
    });
  };
}

export function clearActiveSession(): HyperActions {
  return {
    type: SESSION_CLEAR_ACTIVE
  };
}

// Sets the per-pane description (used by the agent's auto_describe). Does NOT
// touch the tab name — tab names live on the root group, not on sessions.
export function setSessionDescription(uid: string, description: string) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    // uid might be a termGroup uid — resolve to session uid
    const sessionUid = getState().termGroups.activeSessions[uid] || uid;
    window.rpc.emit('session set description', {uid: sessionUid, description});
    // Keep the second field for back-compat with the SESSION_SET_DESCRIPTION
    // reducer signature, but pass empty so it does not overwrite a real tab name.
    dispatch({
      type: SESSION_SET_DESCRIPTION,
      uid: sessionUid,
      description,
      tabName: ''
    });
  };
}

// Sets the tab name on the root term group (the sole source of truth).
// Also dispatches the legacy SESSION_SET_TAB_NAME so any consumer that still
// reads session.tabName (e.g. the bridge sync) stays in sync.
export function setSessionTabName(uid: string, tabName: string, sync = true) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const sessionUid = getState().termGroups.activeSessions[uid] || uid;
    if (sync) {
      window.rpc.emit('session set tab name', {uid: sessionUid, tabName});
    }
    // Source of truth: the root group.
    dispatch({type: TERM_GROUP_SET_TAB_NAME, uid: sessionUid, tabName} as any);
    // Back-compat: also update the per-session field so anything still reading it
    // (bridge mirror, plugins) sees the same name.
    dispatch({
      type: SESSION_SET_TAB_NAME,
      uid: sessionUid,
      tabName
    });
  };
}

export function setSessionXtermTitle(uid: string, title: string): HyperActions {
  // Notify main process so Electron window title + taskbar update
  window.rpc.emit('session set xterm title', {uid, title});
  return {
    type: SESSION_SET_XTERM_TITLE,
    uid,
    title
  };
}

export function resizeSession(uid: string, cols: number, rows: number) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const {termGroups} = getState();
    const group = findBySession(termGroups, uid)!;
    const isStandaloneTerm = !group.parentUid && !group.children.length;
    const now = Date.now();
    dispatch({
      type: SESSION_RESIZE,
      uid,
      cols,
      rows,
      isStandaloneTerm,
      now,
      effect() {
        rpc.emit('resize', {uid, cols, rows});
      }
    });
  };
}

export function openSearch(uid?: string) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const targetUid = uid || getState().sessions.activeUid!;
    dispatch({
      type: SESSION_SEARCH,
      uid: targetUid,
      value: true
    });
  };
}

export function closeSearch(uid?: string, keyEvent?: any) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const targetUid = uid || getState().sessions.activeUid!;
    if (getState().sessions.sessions[targetUid]?.search) {
      dispatch({
        type: SESSION_SEARCH,
        uid: targetUid,
        value: false
      });
    } else {
      if (keyEvent) {
        keyEvent.catched = false;
      }
    }
  };
}

export function sendSessionData(uid: string | null, data: string, escaped?: boolean) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    dispatch({
      type: SESSION_USER_DATA,
      data,
      effect() {
        // If no uid is passed, data is sent to the active session.
        const targetUid = uid || getState().sessions.activeUid;

        rpc.emit('data', {uid: targetUid, data, escaped});
      }
    });
  };
}
