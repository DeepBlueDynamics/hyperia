import {CLOSE_TAB, CHANGE_TAB} from '../../typings/constants/tabs';
import {
  UI_WINDOW_MAXIMIZE,
  UI_WINDOW_UNMAXIMIZE,
  UI_OPEN_HAMBURGER_MENU,
  UI_WINDOW_MINIMIZE,
  UI_WINDOW_CLOSE
} from '../../typings/constants/ui';
import type {HyperDispatch, HyperState} from '../../typings/hyper';
import rpc from '../rpc';

import {userExitTermGroup, clearWebPane, setActiveGroup, findLeaves} from './term-groups';

// #148: names of the tab's panes that are running a foreground program (busy),
// so the confirm dialog can say what's about to be killed.
function busyPaneNames(termGroups: any, sessions: any, rootUid: string): string[] {
  const group = termGroups.termGroups[rootUid];
  if (!group) return [];
  const leaves = findLeaves(termGroups, group);
  const names: string[] = [];
  for (const leaf of leaves) {
    const sess = leaf.sessionUid ? sessions.sessions[leaf.sessionUid] : null;
    if (sess && (sess as any).busy) {
      names.push((sess as any).shellName || (sess as any).title || (sess as any).profile || 'a shell');
    }
  }
  return names;
}

export function closeTab(uid: string, opts?: {confirmed?: boolean}) {
  return (dispatch: HyperDispatch, getState: () => HyperState) => {
    const {termGroups, sessions} = getState();
    const group = termGroups.termGroups[uid];
    // If a web pane is overlaying a real terminal, just clear the URL — don't kill the session
    if (group && (group as any).webUrl && group.sessionUid) {
      dispatch(clearWebPane(uid) as any);
      return;
    }
    // #148: warn before closing a tab whose panes are running foreground
    // programs. Main shows the native dialog and echoes back 'close-tab-confirmed'
    // (handled in lib/index.tsx), which re-enters here with confirmed=true.
    if (!opts?.confirmed) {
      const names = busyPaneNames(termGroups, sessions, uid);
      if (names.length > 0) {
        rpc.emit('confirm-close-tab', {uid, names});
        return;
      }
    }
    dispatch({
      type: CLOSE_TAB,
      uid,
      effect() {
        dispatch(userExitTermGroup(uid));
      }
    });
  };
}

export function changeTab(uid: string) {
  return (dispatch: HyperDispatch) => {
    dispatch({
      type: CHANGE_TAB,
      uid,
      effect() {
        dispatch(setActiveGroup(uid));
      }
    });
  };
}

export function maximize() {
  return (dispatch: HyperDispatch) => {
    dispatch({
      type: UI_WINDOW_MAXIMIZE,
      effect() {
        rpc.emit('maximize');
      }
    });
  };
}

export function unmaximize() {
  return (dispatch: HyperDispatch) => {
    dispatch({
      type: UI_WINDOW_UNMAXIMIZE,
      effect() {
        rpc.emit('unmaximize');
      }
    });
  };
}

export function openHamburgerMenu(coordinates: {x: number; y: number}) {
  return (dispatch: HyperDispatch) => {
    dispatch({
      type: UI_OPEN_HAMBURGER_MENU,
      effect() {
        rpc.emit('open hamburger menu', coordinates);
      }
    });
  };
}

export function minimize() {
  return (dispatch: HyperDispatch) => {
    dispatch({
      type: UI_WINDOW_MINIMIZE,
      effect() {
        rpc.emit('minimize');
      }
    });
  };
}

export function close() {
  return (dispatch: HyperDispatch) => {
    dispatch({
      type: UI_WINDOW_CLOSE,
      effect() {
        rpc.emit('close');
      }
    });
  };
}
