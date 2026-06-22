import './v8-snapshot-util';
// Tabler icon webfont — backs every `ti ti-*` glyph in the pane bands,
// navigators, and controls. Without this import the classes resolve to an
// empty box (the close ×, folder, type icons, etc. were all invisible).
import '@tabler/icons-webfont/dist/tabler-icons.css';
import {webFrame} from 'electron';
import React from 'react';

import {createRoot} from 'react-dom/client';
import {Provider} from 'react-redux';

import type {configOptions} from '../typings/config';

import {loadConfig, reloadConfig} from './actions/config';
import init from './actions/index';
import {addNotificationMessage} from './actions/notifications';
import * as sessionActions from './actions/sessions';
import * as termGroupActions from './actions/term-groups';
import * as uiActions from './actions/ui';
import * as updaterActions from './actions/updater';
import AgentToast from './components/agent-toast';
import {activeTerminals} from './components/term';
import WebPaneDialog, {showWebPaneDialog} from './components/web-pane-dialog';
import HyperContainer from './containers/hyper';
import * as permissionsBus from './permissions-bus';
import rpc from './rpc';
import {getRootGroups} from './selectors';
import configureStore from './store/configure-store';
import * as config from './utils/config';
import {getBase64FileData} from './utils/file';
import * as plugins from './utils/plugins';

// On Linux, the default zoom was somehow changed with Electron 3 (or maybe 2).
// Setting zoom factor to 1.2 brings back the normal default size
if (process.platform === 'linux') {
  webFrame.setZoomFactor(1.2);
}

const store_ = configureStore();

Object.defineProperty(window, 'store', {get: () => store_});
Object.defineProperty(window, 'rpc', {get: () => rpc});
Object.defineProperty(window, 'config', {get: () => config});
Object.defineProperty(window, 'plugins', {get: () => plugins});

const fetchFileData = (configData: configOptions) => {
  const configInfo: configOptions = {...configData, bellSound: null};
  if (!configInfo.bell || configInfo.bell.toUpperCase() !== 'SOUND' || !configInfo.bellSoundURL) {
    store_.dispatch(reloadConfig(configInfo));
    return;
  }

  void getBase64FileData(configInfo.bellSoundURL).then((base64FileData) => {
    // prepend "base64," to the result of this method in order for this to work properly within xterm.js
    const bellSound = !base64FileData ? null : 'base64,' + base64FileData;
    configInfo.bellSound = bellSound;
    store_.dispatch(reloadConfig(configInfo));
  });
};

// initialize config
store_.dispatch(loadConfig(config.getConfig()));
fetchFileData(config.getConfig());

config.subscribe(() => {
  const configInfo = config.getConfig();
  configInfo.bellSound = store_.getState().ui.bellSound;
  // The only async part of the config is the bellSound so we will check if the bellSoundURL
  // has changed to determine if we should re-read this file and dispatch an update to the config
  if (store_.getState().ui.bellSoundURL !== config.getConfig().bellSoundURL) {
    fetchFileData(configInfo);
  } else {
    // No change in the bellSoundURL so continue with a normal reloadConfig, reusing the value
    // we already have for `bellSound`
    store_.dispatch(reloadConfig(configInfo));
  }
});

// initialize communication with main electron process
// and subscribe to all user intents for example from menus
rpc.on('ready', () => {
  store_.dispatch(init());
  store_.dispatch(uiActions.setFontSmoothing());
});

rpc.on('session add', (data) => {
  store_.dispatch(sessionActions.addSession(data));
});

rpc.on('session data', (d: string) => {
  // the uid is a uuid v4 so it's 36 chars long
  const uid = d.slice(0, 36);
  const data = d.slice(36);
  store_.dispatch(sessionActions.addSessionData(uid, data));
});

rpc.on('session data send', ({uid, data, escaped}) => {
  store_.dispatch(sessionActions.sendSessionData(uid, data, escaped));
});

rpc.on('session exit', ({uid}) => {
  store_.dispatch(termGroupActions.ptyExitTermGroup(uid));
});

rpc.on('session rename', ({uid, name}: {uid: string; name: string}) => {
  store_.dispatch(sessionActions.setSessionTabName(uid, name, false) as any);
});

rpc.on('session cwd', ({uid, cwd}: {uid: string; cwd: string}) => {
  store_.dispatch(sessionActions.setSessionCwd(uid, cwd));
});

// Agent / Stream-Deck focus. The sidecar's /api/pane/focus (terminal_focus)
// resolves a pane and has the bridge emit `session set active`. The renderer had
// no listener for it, so a focus command reached the window and did nothing —
// the tab/pane never moved. Dispatching setActiveSession fixes the whole chain:
// the term-groups reducer selects the TAB that owns the pane (SESSION_SET_ACTIVE
// → setActiveGroup), and the hyper container's activeSession effect gives that
// pane keyboard focus. This is purely in-window — it never raises the OS window
// over other apps (Chrome / terminal / Docker stay foreground), and a later user
// click on any other pane or tab just takes over normally.
rpc.on('session set active', ({uid}: {uid: string}) => {
  store_.dispatch(sessionActions.setActiveSession(uid) as any);
  // Focus explicitly too, covering the case where the pane was already the
  // active session but the window had lost DOM focus to another app.
  setTimeout(() => window.focusActiveTerm?.(uid), 0);
});

rpc.on('permission request', (req) => {
  permissionsBus.setRequest(req);
  // Flash the tab that owns the target pane so a consent prompt raised in a
  // BACKGROUND tab is noticeable — but DO NOT move the human's active pane/tab.
  // An agent asking to use a pane must never steal the human's focus; the
  // human's view is theirs and only human input changes it.
  if (req?.targetPane) store_.dispatch(uiActions.markTabBell(req.targetPane));
});

rpc.on('permission resolved', ({targetPane, id}: {targetPane: string; decision: string; id?: string}) => {
  permissionsBus.clearRequest(targetPane);
  if (targetPane) store_.dispatch(uiActions.clearTabBell(targetPane));
  if (id) permissionsBus.clearToast(id);
});

rpc.on('agent toast', (req) => {
  permissionsBus.setToast(req);
});

rpc.on('termgroup close req', () => {
  store_.dispatch(termGroupActions.exitActiveTermGroup());
});

rpc.on('session clear req', () => {
  store_.dispatch(sessionActions.clearActiveSession());
});

rpc.on('session move word left req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x1bb'));
});

rpc.on('session move word right req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x1bf'));
});

rpc.on('session move line beginning req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x1bOH'));
});

rpc.on('session move line end req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x1bOF'));
});

rpc.on('session del word left req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x1b\x7f'));
});

rpc.on('session del word right req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x1bd'));
});

rpc.on('session del line beginning req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x1bw'));
});

rpc.on('session del line end req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x10B'));
});

rpc.on('session break req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x03'));
});

rpc.on('session stop req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x1a'));
});

rpc.on('session quit req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x1c'));
});

rpc.on('session tmux req', () => {
  store_.dispatch(sessionActions.sendSessionData(null, '\x02'));
});

rpc.on('session search', () => {
  store_.dispatch(sessionActions.openSearch());
});

rpc.on('session search close', () => {
  store_.dispatch(sessionActions.closeSearch());
});

rpc.on('termgroup add req', ({activeUid, profile}) => {
  store_.dispatch(termGroupActions.requestTermGroup(activeUid ?? undefined, profile ?? undefined));
});

rpc.on('split request horizontal', ({activeUid, profile, url}) => {
  store_.dispatch(termGroupActions.requestHorizontalSplit(activeUid ?? undefined, profile ?? undefined, url));
});

rpc.on('split request vertical', ({activeUid, profile, url}) => {
  store_.dispatch(termGroupActions.requestVerticalSplit(activeUid ?? undefined, profile ?? undefined, url));
});

rpc.on('clone request vertical', () => {
  const state = store_.getState();
  const activeTermGroup = state.termGroups.activeTermGroup;
  const activeGroup = activeTermGroup ? state.termGroups.termGroups[activeTermGroup] : null;

  if (activeGroup && activeGroup.webUrl !== undefined) {
    store_.dispatch({
      type: 'TERM_GROUP_SPLIT_WEB',
      activeUid: activeTermGroup,
      url: activeGroup.webUrl || '',
      splitDirection: 'VERTICAL'
    } as any);
  } else {
    const activeUid = state.sessions.activeUid;
    const activeSession = activeUid ? state.sessions.sessions[activeUid] : null;
    const profile = activeSession ? activeSession.profile : undefined;
    store_.dispatch(termGroupActions.requestVerticalSplit(activeUid ?? undefined, profile ?? undefined));
  }
});

rpc.on('clone request horizontal', () => {
  const state = store_.getState();
  const activeTermGroup = state.termGroups.activeTermGroup;
  const activeGroup = activeTermGroup ? state.termGroups.termGroups[activeTermGroup] : null;

  if (activeGroup && activeGroup.webUrl !== undefined) {
    store_.dispatch({
      type: 'TERM_GROUP_SPLIT_WEB',
      activeUid: activeTermGroup,
      url: activeGroup.webUrl || '',
      splitDirection: 'HORIZONTAL'
    } as any);
  } else {
    const activeUid = state.sessions.activeUid;
    const activeSession = activeUid ? state.sessions.sessions[activeUid] : null;
    const profile = activeSession ? activeSession.profile : undefined;
    store_.dispatch(termGroupActions.requestHorizontalSplit(activeUid ?? undefined, profile ?? undefined));
  }
});

rpc.on('reset fontSize req', () => {
  const state = store_.getState();
  const activeTermGroup = state.termGroups.activeTermGroup;
  const activeGroup = activeTermGroup ? state.termGroups.termGroups[activeTermGroup] : null;
  const isWebPane = activeGroup && activeGroup.webUrl !== undefined;
  const isChooserPane = activeGroup && !activeGroup.sessionUid && activeGroup.webUrl === undefined;

  if (isWebPane) {
    rpc.emit('web-pane-zoom-reset', {uid: activeTermGroup!});
  } else if (isChooserPane) {
    rpc.emit('picker-zoom-reset', {uid: activeTermGroup!});
  } else {
    store_.dispatch(uiActions.resetFontSize());
  }
});

rpc.on('increase fontSize req', () => {
  const state = store_.getState();
  const activeTermGroup = state.termGroups.activeTermGroup;
  const activeGroup = activeTermGroup ? state.termGroups.termGroups[activeTermGroup] : null;
  const isWebPane = activeGroup && activeGroup.webUrl !== undefined;
  const isChooserPane = activeGroup && !activeGroup.sessionUid && activeGroup.webUrl === undefined;

  if (isWebPane) {
    rpc.emit('web-pane-zoom-in', {uid: activeTermGroup!});
  } else if (isChooserPane) {
    rpc.emit('picker-zoom-in', {uid: activeTermGroup!});
  } else {
    store_.dispatch(uiActions.increaseFontSize());
  }
});

rpc.on('decrease fontSize req', () => {
  const state = store_.getState();
  const activeTermGroup = state.termGroups.activeTermGroup;
  const activeGroup = activeTermGroup ? state.termGroups.termGroups[activeTermGroup] : null;
  const isWebPane = activeGroup && activeGroup.webUrl !== undefined;
  const isChooserPane = activeGroup && !activeGroup.sessionUid && activeGroup.webUrl === undefined;

  if (isWebPane) {
    rpc.emit('web-pane-zoom-out', {uid: activeTermGroup!});
  } else if (isChooserPane) {
    rpc.emit('picker-zoom-out', {uid: activeTermGroup!});
  } else {
    store_.dispatch(uiActions.decreaseFontSize());
  }
});

rpc.on('move left req', () => {
  store_.dispatch(uiActions.moveLeft());
});

rpc.on('move right req', () => {
  store_.dispatch(uiActions.moveRight());
});

rpc.on('move jump req', (index) => {
  store_.dispatch(uiActions.moveTo(index));
});

rpc.on('next pane req', () => {
  store_.dispatch(uiActions.moveToNextPane());
});

rpc.on('prev pane req', () => {
  store_.dispatch(uiActions.moveToPreviousPane());
});

rpc.on('open file', ({path}) => {
  store_.dispatch(uiActions.openFile(path));
});

rpc.on('open ssh', (parsedUrl) => {
  store_.dispatch(uiActions.openSSH(parsedUrl));
});

rpc.on('update available', ({releaseName, releaseNotes, releaseUrl, canInstall}) => {
  store_.dispatch(updaterActions.updateAvailable(releaseName, releaseNotes, releaseUrl, canInstall));
});

rpc.on('move', (window) => {
  store_.dispatch(uiActions.windowMove(window));
});

rpc.on('windowGeometry change', (data) => {
  store_.dispatch(uiActions.windowGeometryUpdated(data));
});

rpc.on('add notification', ({text, url, dismissable}) => {
  store_.dispatch(addNotificationMessage(text, url, dismissable));
});

rpc.on('enter full screen', () => {
  store_.dispatch(uiActions.enterFullScreen());
});

rpc.on('leave full screen', () => {
  store_.dispatch(uiActions.leaveFullScreen());
});

rpc.on('agent status', ({sessionUid, connected, working, label, humanPercent}) => {
  // If no sessionUid provided, fall back to active session
  const uid = sessionUid || store_.getState().sessions.activeUid;
  if (uid) {
    store_.dispatch(uiActions.setAgentStatus(uid, {connected, working, label, humanPercent}));
  }
});

function countLeaves(group: any, termGroups: Record<string, any>): number {
  if (group?.sessionUid) return 1;
  if (group?.webUrl !== undefined && group?.webUrl !== null) return 1;
  const children: string[] = (group?.children as string[]) || [];
  return children.reduce((count: number, childUid: string) => {
    const child = termGroups[childUid];
    return count + (child ? countLeaves(child, termGroups) : 0);
  }, 0);
}

// prettier-ignore
function collectPaneLayout(
  group: any,
  termGroups: Record<string, any>,
  splitOffset = 0,
  isRoot = true
): Array<{
  uid: string;
  splitLabel: string;
  isWeb: boolean;
  isAi: boolean;
  title: string;
  shellName: string;
  url?: string;
  active: boolean;
}> {
  const state = store_.getState() as any;
  const totalLeaves = countLeaves(group, termGroups);
  const needLabels = totalLeaves > 1 || !isRoot;

  if (group?.sessionUid) {
    const session = state.sessions.sessions[group.sessionUid];
    const shellName = session ? session.shellName : '';
    const shellType = session ? session.profile || 'shell' : 'shell';
    const customTitle = session ? session.title : '';
    const title = shellName ? shellName : (customTitle || shellType);
    const active = group.sessionUid === state.sessions.activeUid;
    return [{uid: group.sessionUid, splitLabel: '', isWeb: false, isAi: false, title, shellName, active}];
  }
  if (group?.webUrl !== undefined && group?.webUrl !== null) {
    const isAi = group.webUrl.startsWith('ai://');
    let title = group.webName;
    if (!title && group.webUrl) {
      if (isAi) {
        title = 'ask';
      } else {
        try {
          title = new URL(group.webUrl).hostname || group.webUrl;
        } catch {
          title = group.webUrl;
        }
      }
    }
    if (!title) {
      title = isAi ? 'ask' : 'Browser';
    }
    const active = group.uid === state.termGroups.activeTermGroup;
    return [{uid: group.uid, splitLabel: '', isWeb: true, isAi, title, shellName: '', url: group.webUrl, active}];
  }

  const panes: any[] = [];

  // Collect all leaf uids first (in order), then assign unique sequential labels
  function collectLeaves(g: Record<string, any>): Array<{uid: string; isWeb: boolean; isAi: boolean; title: string; shellName: string; url?: string; active: boolean}> {
    if (!g) return [];
    if (g.sessionUid) {
      const session = state.sessions.sessions[g.sessionUid];
      const shellName = session ? session.shellName : '';
      const shellType = session ? session.profile || 'shell' : 'shell';
      const customTitle = session ? session.title : '';
      const title = shellName ? shellName : (customTitle || shellType);
      const active = g.sessionUid === state.sessions.activeUid;
      return [{uid: g.sessionUid as string, isWeb: false, isAi: false, title, shellName, active}];
    }
    if (g.webUrl !== undefined && g.webUrl !== null) {
      const isAi = g.webUrl.startsWith('ai://');
      let title = g.webName;
      if (!title && g.webUrl) {
        if (isAi) {
          title = 'ask';
        } else {
          try {
            title = new URL(g.webUrl).hostname || g.webUrl;
          } catch {
            title = g.webUrl;
          }
        }
      }
      if (!title) {
        title = isAi ? 'ask' : 'Browser';
      }
      const active = g.uid === state.termGroups.activeTermGroup;
      return [{uid: g.uid as string, isWeb: true, isAi, title, shellName: '', url: g.webUrl, active}];
    }
    const children: string[] = (g.children as string[]) || [];
    return children.flatMap((cUid: string) => collectLeaves(termGroups[cUid] as Record<string, any>));
  }

  const leaves = collectLeaves(group as Record<string, any>);
  leaves.forEach((leaf, idx) => {
    const splitLabel = needLabels ? String.fromCharCode(97 + splitOffset + idx) : '';
    panes.push({
      ...leaf,
      splitLabel
    });
  });

  return panes;
}

function calcBspLayout(
  node: Record<string, any>,
  termGroups: Record<string, any>,
  x: number,
  y: number,
  w: number,
  h: number,
  results: Array<{uid: string; x: number; y: number; width: number; height: number}>
): void {
  if (!node) return;
  if (node.sessionUid) {
    results.push({uid: node.sessionUid as string, x, y, width: w, height: h});
    return;
  }
  if (node.webUrl !== undefined && node.webUrl !== null) {
    results.push({uid: node.uid as string, x, y, width: w, height: h});
    return;
  }
  const children: string[] = (node.children as string[]) || [];
  if (children.length < 2) {
    if (children[0]) calcBspLayout(termGroups[children[0]] as Record<string, any>, termGroups, x, y, w, h, results);
    return;
  }
  const ratio: number = (node.sizes?.[0] as number) ?? 0.5;
  // direction: "HORIZONTAL" = top/bottom split, "VERTICAL" = left/right split (Hyper convention)
  if (node.direction === 'HORIZONTAL') {
    const topH = Math.round(h * ratio);
    calcBspLayout(termGroups[children[0]] as Record<string, any>, termGroups, x, y, w, topH, results);
    calcBspLayout(termGroups[children[1]] as Record<string, any>, termGroups, x, y + topH, w, h - topH, results);
  } else {
    const leftW = Math.round(w * ratio);
    calcBspLayout(termGroups[children[0]] as Record<string, any>, termGroups, x, y, leftW, h, results);
    calcBspLayout(termGroups[children[1]] as Record<string, any>, termGroups, x + leftW, y, w - leftW, h, results);
  }
}

let lastLayoutSignature = '';
store_.subscribe(() => {
  const state = store_.getState();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const rootGroups = getRootGroups(state as any);
  const tabs = rootGroups.map((rootGroup: any, order: number) => {
    const bspResults: Array<{uid: string; x: number; y: number; width: number; height: number}> = [];
    calcBspLayout(
      rootGroup as Record<string, any>,
      state.termGroups.termGroups as Record<string, any>,
      0,
      0,
      100,
      100,
      bspResults
    );
    return {
      rootGroupUid: rootGroup.uid,
      order,
      active: rootGroup.uid === state.termGroups.activeRootGroup,
      panes: collectPaneLayout(rootGroup, state.termGroups.termGroups),
      bsp: bspResults
    };
  });
  const signature = JSON.stringify(tabs);
  if (signature === lastLayoutSignature) return;
  lastLayoutSignature = signature;
  rpc.emit('session layout sync', tabs);
});

const root = createRoot(document.getElementById('mount')!);

root.render(
  <Provider store={store_}>
    <HyperContainer />
    <WebPaneDialog />
    <AgentToast />
  </Provider>
);

rpc.on('reload', () => {
  plugins.reload();
});

rpc.on(
  'split web pane req',
  ({activeUid, url, direction}: {activeUid?: string | null; url?: string; direction?: 'HORIZONTAL' | 'VERTICAL'}) => {
    if (url) {
      const full = /^[a-z]+:\/\//i.test(url) ? url : 'https://' + url;
      store_.dispatch(termGroupActions.splitWebPane(activeUid ?? undefined, full, direction ?? 'HORIZONTAL') as any);
    }
  }
);

rpc.on('open web pane req', ({url}: {url?: string}) => {
  if (url) {
    const full = /^https?:\/\//i.test(url) ? url : 'https://' + url;
    store_.dispatch(termGroupActions.openWebPaneInNewTab(full) as any);
  } else {
    showWebPaneDialog((full) => {
      store_.dispatch(termGroupActions.openWebPaneInNewTab(full) as any);
    });
  }
});

rpc.on('get-layout-state-req', () => {
  const {termGroups, sessions} = store_.getState();

  const serializedSessions: Record<string, any> = {};
  Object.keys(sessions.sessions).forEach((uid) => {
    const s = sessions.sessions[uid];
    if (s) {
      const activeTerm = activeTerminals.get(uid);
      const lastCommand = activeTerm ? activeTerm.getCurrentCommandLine() : s.lastCommand || '';
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
        lastCommand
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
        children: g.children ? g.children.asMutable() : [],
        webUrl: (g as any).webUrl,
        webName: (g as any).webName,
        tabName: g.tabName
      };
    }
  });

  const layoutState = {
    activeUid: sessions.activeUid,
    activeRootGroup: termGroups.activeRootGroup,
    activeSessions: termGroups.activeSessions ? termGroups.activeSessions.asMutable() : {},
    termGroups: serializedTermGroups,
    sessions: serializedSessions
  };

  rpc.emit('layout-state-reply', layoutState);
});

rpc.on('restore-layout-state', (savedState) => {
  store_.dispatch(termGroupActions.restoreLayoutState(savedState));
});
