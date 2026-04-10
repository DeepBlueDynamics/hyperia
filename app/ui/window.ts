import {existsSync} from 'fs';
import {isAbsolute, normalize, sep} from 'path';
import {URL, fileURLToPath} from 'url';

import {app, BrowserWindow, shell, Menu, nativeImage} from 'electron';
import type {BrowserWindowConstructorOptions} from 'electron';

import {enable as remoteEnable} from '@electron/remote/main';
import isDev from 'electron-is-dev';
let getWorkingDirectoryFromPID: (pid: number) => string | null = () => null;
try {
  ({getWorkingDirectoryFromPID} = require('native-process-working-directory'));
} catch {
  console.warn('native-process-working-directory not available (Python needed to build). CWD detection disabled.');
}
import {v4 as uuidv4} from 'uuid';

import type {sessionExtraOptions} from '../../typings/common';
import type {configOptions} from '../../typings/config';
import {
  registerSession,
  notifyResize,
  notifyUserActivity,
  updateSessionDescription,
  updateSessionTabName,
  updateSessionLayout,
  updateSessionActive,
  updateWindowFocus,
  getSessionRootTab,
  forceRemoveSession
} from '../bridge';
import {execCommand} from '../commands';
import {getDefaultProfile} from '../config';
import {icon, homeDirectory} from '../config/paths';
import fetchNotifications from '../notifications';
import notify from '../notify';
import {decorateSessionOptions, decorateSessionClass} from '../plugins';
import createRPC from '../rpc';
import Session from '../session';
import {startSessionLog, writeSessionLog, endSessionLog} from '../session-logger';
import updater from '../updater';
import {setRendererType, unsetRendererType} from '../utils/renderer-utils';
import toElectronBackgroundColor from '../utils/to-electron-background-color';

import contextMenuTemplate from './contextmenu';

// Tab names are assigned by the renderer and synced via 'session set tab name' RPC.
// The main process no longer generates names.

function makeLetterIcon(letter: string): Electron.NativeImage {
  // Generate a 32x32 PNG with a single letter via canvas-free SVG→PNG
  const ch = (letter || 'H').charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
    <rect width="32" height="32" rx="6" fill="#1a1a2e"/>
    <text x="16" y="23" text-anchor="middle" font-family="sans-serif"
          font-size="20" font-weight="bold" fill="#fff">${ch}</text>
  </svg>`;
  return nativeImage.createFromBuffer(Buffer.from(svg));
}

export function newWindow(
  options_: BrowserWindowConstructorOptions,
  cfg: configOptions,
  fn?: (win: BrowserWindow) => void,
  profileName: string = getDefaultProfile()
): BrowserWindow {
  const classOpts = Object.assign({uid: uuidv4()});
  app.plugins.decorateWindowClass(classOpts);

  const winOpts: BrowserWindowConstructorOptions = {
    minWidth: 370,
    minHeight: 190,
    backgroundColor: toElectronBackgroundColor(cfg.backgroundColor || '#000'),
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'hiddenInset',
    title: 'Hyperia',
    // Frameless on Linux, native overlay on Windows for snap layouts, inset on Mac
    frame: process.platform !== 'linux',
    transparent: process.platform === 'darwin',
    ...(process.platform === 'win32'
      ? {
          titleBarOverlay: {
            color: '#1a1a1a',
            symbolColor: '#ffffff',
            height: 34
          }
        }
      : {}),
    icon,
    show: Boolean(process.env.HYPER_DEBUG || process.env.HYPERTERM_DEBUG || isDev),
    acceptFirstMouse: true,
    webPreferences: {
      nodeIntegration: true,
      navigateOnDragDrop: true,
      contextIsolation: false,
      webviewTag: true
    },
    ...options_
  };
  const window = new BrowserWindow(app.plugins.getDecoratedBrowserOptions(winOpts));

  window.profileName = profileName;

  // Enable remote module on this window
  remoteEnable(window.webContents);

  // Log renderer crashes and console errors
  window.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    if (level >= 2) {
      // warnings and errors
      console.error(`[renderer] ${message} (${sourceId}:${line})`);
    }
  });
  window.webContents.on('render-process-gone', (_ev, details) => {
    console.error('[renderer] Process gone:', details.reason);
  });

  window.uid = classOpts.uid;

  app.plugins.onWindowClass(window);
  window.uid = classOpts.uid;

  const rpc = createRPC(window);
  const sessions = new Map<string, Session>();

  const updateBackgroundColor = () => {
    const cfg_ = app.plugins.getDecoratedConfig(profileName);
    window.setBackgroundColor(toElectronBackgroundColor(cfg_.backgroundColor || '#000'));
  };

  // config changes
  const cfgUnsubscribe = app.config.subscribe(() => {
    const cfg_ = app.plugins.getDecoratedConfig(profileName);

    // notify renderer
    window.webContents.send('config change');

    // notify user that shell changes require new sessions
    if (cfg_.shell !== cfg.shell || JSON.stringify(cfg_.shellArgs) !== JSON.stringify(cfg.shellArgs)) {
      notify('Shell configuration changed!', 'Open a new tab or window to start using the new shell');
    }

    // update background color if necessary
    updateBackgroundColor();

    cfg = cfg_;
  });

  rpc.on('init', () => {
    window.show();
    updateBackgroundColor();

    // If no callback is passed to createWindow,
    // a new session will be created by default.
    if (!fn) {
      fn = (win: BrowserWindow) => {
        win.rpc.emit('termgroup add req', {});
      };
    }

    // app.windowCallback is the createWindow callback
    // that can be set before the 'ready' app event
    // and createWindow definition. It's executed in place of
    // the callback passed as parameter, and deleted right after.
    (app.windowCallback || fn)(window);
    app.windowCallback = undefined;
    fetchNotifications(window);
    // auto updates
    if (!isDev) {
      updater(window);
    } else {
      console.log('ignoring auto updates during dev');
    }
  });

  function createSession(extraOptions: sessionExtraOptions = {}) {
    const uid = uuidv4();
    const extraOptionsFiltered: sessionExtraOptions = {};
    Object.keys(extraOptions).forEach((key) => {
      if (extraOptions[key] !== undefined) extraOptionsFiltered[key] = extraOptions[key];
    });

    const profile = extraOptionsFiltered.profile || profileName;
    const activeSession = extraOptionsFiltered.activeUid ? sessions.get(extraOptionsFiltered.activeUid) : undefined;
    let cwd = '';
    if (cfg.preserveCWD !== false && activeSession && activeSession.profile === profile) {
      const activePID = activeSession.pty?.pid;
      if (activePID !== undefined) {
        try {
          cwd = getWorkingDirectoryFromPID(activePID) || '';
        } catch (error) {
          console.error(error);
        }
      }
      cwd = cwd && isAbsolute(cwd) && existsSync(cwd) ? cwd : '';
    }

    const profileCfg = app.plugins.getDecoratedConfig(profile);

    // set working directory
    let argPath = process.argv[1];
    if (argPath && process.platform === 'win32') {
      if (/[a-zA-Z]:"/.test(argPath)) {
        argPath = argPath.replace('"', sep);
      }
      argPath = normalize(argPath + sep);
    }
    let workingDirectory = homeDirectory;
    if (argPath && isAbsolute(argPath)) {
      workingDirectory = argPath;
    } else if (profileCfg.workingDirectory && isAbsolute(profileCfg.workingDirectory)) {
      workingDirectory = profileCfg.workingDirectory;
    }

    // remove the rows and cols, the wrong value of them will break layout when init create
    const defaultOptions = Object.assign(
      {
        cwd: cwd || workingDirectory,
        splitDirection: undefined,
        shell: profileCfg.shell,
        shellArgs: profileCfg.shellArgs && Array.from(profileCfg.shellArgs)
      },
      extraOptionsFiltered,
      {
        profile: extraOptionsFiltered.profile || profileName,
        uid
      }
    );
    const options = decorateSessionOptions(defaultOptions);
    const DecoratedSession = decorateSessionClass(Session);
    const session = new DecoratedSession(options);
    sessions.set(uid, session);
    return {session, options};
  }

  rpc.on('new', (extraOptions) => {
    const {session, options} = createSession(extraOptions);

    sessions.set(options.uid, session);
    rpc.emit('session add', {
      rows: options.rows,
      cols: options.cols,
      uid: options.uid,
      splitDirection: options.splitDirection,
      shell: session.shell,
      pid: session.pty ? session.pty.pid : null,
      activeUid: options.activeUid ?? undefined,
      profile: options.profile
    });

    // Register with sidecar bridge for agent control
    // If this is a split, inherit the rootTabUid from the parent session
    const parentRootTab = options.activeUid ? getSessionRootTab(options.activeUid) : '';
    const rootTabUid = options.splitDirection ? parentRootTab || options.activeUid || options.uid : options.uid;
    registerSession(
      options.uid,
      session,
      options.rows || 24,
      options.cols || 80,
      session.shell || 'shell',
      '', // tab name assigned by renderer via 'session set tab name'
      rootTabUid,
      window.id
    );

    // Start session logging if enabled
    if (cfg.sessionLogging) {
      startSessionLog(options.uid, session.shell || 'shell');
    }

    session.on('data', (data: string) => {
      rpc.emit('session data', data);
      if (cfg.sessionLogging) writeSessionLog(options.uid, data);
    });

    session.on('exit', () => {
      console.log(`[window] Session exit event: ${options.uid}`);
      rpc.emit('session exit', {uid: options.uid});
      endSessionLog(options.uid);
      unsetRendererType(options.uid);
      sessions.delete(options.uid);
    });
  });

  rpc.on('exit', ({uid}) => {
    console.log(`[window] RPC exit request: ${uid} (session exists: ${sessions.has(uid)})`);
    const session = sessions.get(uid);
    if (session) {
      session.exit();
      // Safety net: if session.on('exit') doesn't fire within 3s, force cleanup
      setTimeout(() => {
        if (sessions.has(uid)) {
          console.warn(`[window] Session ${uid} didn't exit cleanly — force removing`);
          sessions.delete(uid);
          forceRemoveSession(uid);
        }
      }, 3000);
    } else {
      // Session already gone from our map but might be stuck in the bridge
      forceRemoveSession(uid);
    }
  });
  rpc.on('unmaximize', () => {
    window.unmaximize();
  });
  rpc.on('maximize', () => {
    window.maximize();
  });
  rpc.on('minimize', () => {
    window.minimize();
  });
  rpc.on('resize', ({uid, cols, rows}) => {
    const session = sessions.get(uid);
    if (session) {
      session.resize({cols, rows});
      notifyResize(uid, rows, cols);
    }
  });
  rpc.on('data', ({uid, data, escaped}) => {
    if (uid) notifyUserActivity(uid);
    const session = uid && sessions.get(uid);
    if (session) {
      if (escaped) {
        const escapedData = session.shell?.endsWith('cmd.exe')
          ? `"${data}"` // This is how cmd.exe does it
          : `'${data.replace(/'/g, `'\\''`)}'`; // Inside a single-quoted string nothing is interpreted

        session.write(escapedData);
      } else {
        session.write(data);
      }
    }
  });
  rpc.on('session set active', ({uid}: {uid: string}) => {
    updateSessionActive(uid, window.id);
  });
  rpc.on('session set description', ({uid, description}: {uid: string; description: string}) => {
    updateSessionDescription(uid, description);
  });
  rpc.on('session set tab name', ({uid, tabName}: {uid: string; tabName: string}) => {
    updateSessionTabName(uid, tabName);
  });
  rpc.on(
    'session layout sync',
    (
      payload: Array<{
        rootGroupUid: string;
        order: number;
        active: boolean;
        panes: Array<{uid: string; splitLabel: string}>;
      }>
    ) => {
      updateSessionLayout(payload);
    }
  );
  rpc.on('info renderer', ({uid, type}) => {
    // Used in the "About" dialog
    setRendererType(uid, type);
  });
  rpc.on('open external', ({url}) => {
    void shell.openExternal(url);
  });
  rpc.on('open context menu', (selection) => {
    const {createWindow} = app;
    Menu.buildFromTemplate(contextMenuTemplate(createWindow, selection, window)).popup({
      window
    });
  });
  rpc.on('open hamburger menu', ({x, y}) => {
    Menu.getApplicationMenu()!.popup({x: Math.ceil(x), y: Math.ceil(y)});
  });
  // Update Electron window title + taskbar icon when active session title changes
  rpc.on('session set xterm title', ({title}: {uid: string; title: string}) => {
    // Only update window chrome — tab names come from renderer via 'session set tab name'
    if (title) {
      window.setTitle(`${title} — Hyperia`);
      if (process.platform === 'win32') {
        window.setIcon(makeLetterIcon(title));
      }
    } else {
      window.setTitle('Hyperia');
      if (process.platform === 'win32') {
        window.setIcon(icon);
      }
    }
  });
  // Same deal as above, grabbing the window titlebar when the window
  // is maximized on Windows results in unmaximize, without hitting any
  // app buttons
  const onGeometryChange = () => rpc.emit('windowGeometry change', {isMaximized: window.isMaximized()});
  window.on('maximize', onGeometryChange);
  window.on('unmaximize', onGeometryChange);
  window.on('minimize', onGeometryChange);
  window.on('restore', onGeometryChange);

  window.on('move', () => {
    const position = window.getPosition();
    rpc.emit('move', {bounds: {x: position[0], y: position[1]}});
  });
  rpc.on('close', () => {
    window.close();
  });
  rpc.on('command', (command) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    execCommand(command, focusedWindow!);
  });
  // pass on the full screen events from the window to react
  rpc.win.on('enter-full-screen', () => {
    rpc.emit('enter full screen');
  });
  rpc.win.on('leave-full-screen', () => {
    rpc.emit('leave full screen');
  });
  const deleteSessions = () => {
    sessions.forEach((session, key) => {
      session.removeAllListeners();
      session.destroy();
      forceRemoveSession(key);
      endSessionLog(key);
      sessions.delete(key);
    });
  };
  // we reset the rpc channel only upon
  // subsequent refreshes (ie: F5)
  let i = 0;
  window.webContents.on('did-navigate', () => {
    if (i++) {
      deleteSessions();
    }
  });

  const handleDroppedURL = (url: string) => {
    const protocol = typeof url === 'string' && new URL(url).protocol;
    if (protocol === 'file:') {
      const path = fileURLToPath(url);
      return {uid: null, data: path, escaped: true};
    } else if (protocol === 'http:' || protocol === 'https:') {
      return {uid: null, data: url};
    }
  };

  // If file is dropped onto the terminal window, navigate and new-window events are prevented
  // and it's path is added to active session.
  window.webContents.on('will-navigate', (event, url) => {
    const data = handleDroppedURL(url);
    if (data) {
      event.preventDefault();
      rpc.emit('session data send', data);
    }
  });
  window.webContents.setWindowOpenHandler(({url}) => {
    const data = handleDroppedURL(url);
    if (data) {
      rpc.emit('session data send', data);
      return {action: 'deny'};
    }
    return {action: 'allow'};
  });

  // expose internals to extension authors
  window.rpc = rpc;
  window.sessions = sessions;

  const load = () => {
    app.plugins.onWindow(window);
  };

  // load plugins
  load();

  const pluginsUnsubscribe = app.plugins.subscribe((err: any) => {
    if (!err) {
      load();
      window.webContents.send('plugins change');
      updateBackgroundColor();
    }
  });

  // Keep track of focus time of every window, to figure out
  // which one of the existing window is the last focused.
  // Works nicely even if a window is closed and removed.
  const updateFocusTime = () => {
    window.focusTime = process.uptime();
    updateWindowFocus(window.id);
  };

  window.on('focus', () => {
    updateFocusTime();
  });

  // the window can be closed by the browser process itself
  window.clean = () => {
    app.config.winRecord(window);
    rpc.destroy();
    deleteSessions();
    cfgUnsubscribe();
    pluginsUnsubscribe();
  };
  // Ensure focusTime is set on window open. The focus event doesn't
  // fire from the dock (see bug #583)
  updateFocusTime();

  return window;
}
