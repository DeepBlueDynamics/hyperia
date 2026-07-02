import {existsSync, readFileSync, writeFileSync} from 'fs';
import {dirname, isAbsolute, join, normalize, sep} from 'path';
import {URL, fileURLToPath} from 'url';

import {app, BrowserWindow, shell, Menu, dialog, ipcMain, nativeImage} from 'electron';
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
  updateSessionCwd,
  updateSessionTabName,
  updateSessionLayout,
  updateSessionActive,
  updateWindowFocus,
  updateWindowBounds,
  getSessionRootTab,
  forceRemoveSession,
  executeSessionCd
} from '../bridge';
import {execCommand} from '../commands';
import {getDefaultProfile} from '../config';
import {initWebPaneManager, destroyPanesForWindow} from '../web-pane-manager';
import {icon, homeDirectory, cfgPath} from '../config/paths';
import {getAppIcon} from '../utils/icon';
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

// Web panes spoof a Chrome User-Agent (see BROWSER_UA), but the <webview>
// `useragent` attribute only changes the UA *string* — Chromium still emits
// `sec-ch-ua` client hints that carry the "Electron" brand. Cloudflare's managed
// challenge cross-checks the UA against those hints, so a Chrome UA paired with
// Electron client hints loops on "Just a moment…" forever. Rewrite the outgoing
// headers so UA AND client hints both say Google Chrome, consistently.
const configuredWebPaneSessions = new WeakSet<Electron.Session>();
function chromeHeaderSet() {
  const full = process.versions.chrome || '146.0.0.0';
  const major = full.split('.')[0];
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  const uaPlat = isMac
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : isLinux
      ? 'X11; Linux x86_64'
      : 'Windows NT 10.0; Win64; x64';
  const chPlat = isMac ? '"macOS"' : isLinux ? '"Linux"' : '"Windows"';
  const platVersion = isMac ? '"13.0.0"' : isLinux ? '"6.0.0"' : '"10.0.0"';
  return {
    ua: `Mozilla/5.0 (${uaPlat}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    brands: `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="24"`,
    fullVersionList: `"Chromium";v="${full}", "Google Chrome";v="${full}", "Not?A_Brand";v="24.0.0.0"`,
    platform: chPlat,
    platformVersion: platVersion
  };
}
function configureWebPaneSession(sess: Electron.Session) {
  if (!sess || configuredWebPaneSessions.has(sess)) return;
  configuredWebPaneSessions.add(sess);
  try {
    sess.setSpellCheckerEnabled(true);
  } catch (err) {
    console.error('[web-pane] failed to enable spellchecker:', err);
  }
  const {ua, brands, fullVersionList, platform, platformVersion} = chromeHeaderSet();
  // Set the SESSION user agent too — this is what navigator.userAgent reports
  // inside the page. The header rewrite below only covers HTTP; without this a
  // WebContentsView page sees the raw Electron UA in JS, and the JS-vs-header
  // mismatch trips login bot detection (LinkedIn boots the session, e.g.).
  // (The old <webview> got this via its useragent= attribute.)
  try {
    sess.setUserAgent(ua);
  } catch (err) {
    console.error('[web-pane] setUserAgent failed:', err);
  }
  sess.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = details.requestHeaders;
    h['User-Agent'] = ua;
    // Drop whatever case Chromium sent the hints in, then set the Chrome set.
    for (const k of Object.keys(h)) {
      const lk = k.toLowerCase();
      if (
        lk === 'sec-ch-ua' ||
        lk === 'sec-ch-ua-full-version-list' ||
        lk === 'sec-ch-ua-platform' ||
        lk === 'sec-ch-ua-platform-version' ||
        lk === 'sec-ch-ua-mobile'
      ) {
        delete h[k];
      }
    }
    h['sec-ch-ua'] = brands;
    h['sec-ch-ua-mobile'] = '?0';
    h['sec-ch-ua-platform'] = platform;
    h['sec-ch-ua-platform-version'] = platformVersion;
    h['sec-ch-ua-full-version-list'] = fullVersionList;
    callback({requestHeaders: h});
  });
}

// A guaranteed-valid shell for this host. Used when a session's configured shell
// is empty or its binary is missing — otherwise node-pty throws "File not found"
// and that UNCAUGHT exception crashes the whole main process (e.g. an agent
// splitting a pane with no/invalid profile, /api/pane/split with no shell).
function fallbackShell(): string {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe'
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return 'cmd.exe';
  }
  const sh = process.env.SHELL;
  if (sh && existsSync(sh)) return sh;
  for (const c of ['/bin/zsh', '/bin/bash', '/bin/sh']) if (existsSync(c)) return c;
  return '/bin/sh';
}

// Decode the app icon into a NativeImage for the window/taskbar. Passing the raw
// .ico STRING path to BrowserWindow.icon is unreliable on Windows — and from
// inside app.asar it doesn't resolve at all — which is why the window kept
// falling back to the default Electron atom. nativeImage decodes it in-process;
// if the .ico won't load we fall back to the 256px PNG read straight through fs
// (fs reads inside asar). Cached after first successful build.
function windowIcon(): Electron.NativeImage | string {
  return getAppIcon();
}

let webPaneManagerInited = false;

export function newWindow(
  options_: BrowserWindowConstructorOptions,
  cfg: configOptions,
  fn?: (win: BrowserWindow) => void,
  profileName: string = getDefaultProfile()
): BrowserWindow {
  // Register the WebContentsView IPC surface once (idempotent guard). Reuses the
  // exact same session config the legacy <webview> path uses.
  if (!webPaneManagerInited) {
    webPaneManagerInited = true;
    initWebPaneManager({configureSession: configureWebPaneSession});
  }
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
    icon: windowIcon(),
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

  // Belt-and-suspenders: explicitly re-apply the window icon onto the live OS
  // handle after creation. winOpts.icon already sets it, but a fresh WM_SETICON
  // here can dislodge a taskbar button that cached a stale icon at create time.
  // Keep the PNG nativeImage — a .ico string regresses to the atom fallback
  // (see config/paths.ts:61).
  if (process.platform === 'win32') {
    const winIco = getAppIcon();
    window.setIcon(typeof winIco === 'string' ? nativeImage.createFromPath(winIco) : winIco);
  }

  window.profileName = profileName;
  (window as any).tabCount = 1;
  (window as any).paneCount = 1;

  // Enable remote module on this window
  remoteEnable(window.webContents);

  // Electron >= 28: @electron/remote's module.parent traversal loses the app
  // root as base for relative requires. Intercept and resolve manually.

  const wc = window.webContents as any;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  wc.on('remote-require', (event: any, moduleName: string) => {
    if (moduleName === './plugins') {
      event.returnValue = require('../plugins');
    } else if (moduleName === './config') {
      event.returnValue = require('../config');
    }
  });

  // Log renderer console output to main process (all levels)
  window.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    const tag = `[renderer] ${message} (${sourceId}:${line})`;
    if (level >= 3) console.error(tag);
    else if (level >= 2) console.warn(tag);
    else if (level >= 1) console.log(tag);
    else isDev && console.log(tag);
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

    // update background color if necessary
    updateBackgroundColor();

    cfg = cfg_;
  });

  rpc.on('init', () => {
    window.show();
    updateBackgroundColor();

    let hasRestored = false;
    try {
      if (existsSync(cfgPath)) {
        const currentConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));
        if (currentConfig.savedLayoutState) {
          console.log('[window] Found savedLayoutState in config, triggering restore...');
          rpc.emit('restore-layout-state', currentConfig.savedLayoutState);
          delete currentConfig.savedLayoutState;
          writeFileSync(cfgPath, JSON.stringify(currentConfig, null, 2), 'utf8');
          hasRestored = true;
        }
      }
    } catch (e) {
      console.error('[window] Error reading/deleting savedLayoutState during init:', e);
    }

    if (!hasRestored) {
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
    }
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
    const uid = extraOptions.uid || uuidv4();
    const extraOptionsFiltered: sessionExtraOptions = {};
    Object.keys(extraOptions).forEach((key) => {
      if (extraOptions[key] !== undefined) extraOptionsFiltered[key] = extraOptions[key];
    });

    const profile = extraOptionsFiltered.profile || profileName;
    const activeSession = extraOptionsFiltered.activeUid ? sessions.get(extraOptionsFiltered.activeUid) : undefined;
    let cwd = '';
    if (activeSession && activeSession.profile === profile) {
      cwd = activeSession.cwd || '';
      if (!cwd && cfg.preserveCWD !== false) {
        const activePID = activeSession.pty?.pid;
        if (activePID !== undefined) {
          try {
            cwd = getWorkingDirectoryFromPID(activePID) || '';
          } catch (error) {
            console.error(error);
          }
        }
      }
      cwd = cwd && isAbsolute(cwd) && existsSync(cwd) ? cwd : '';
    }

    const profileCfg = app.plugins.getDecoratedConfig(profile);

    // set working directory
    let argPath = process.argv[1];
    if (argPath && process.platform === 'win32') {
      if (/[a-zA-Z]:"/.test(argPath)) {
        // /g — without it the string-form replace only swaps the first
        // quote, leaving subsequent ones in the path. CodeQL
        // js/incomplete-sanitization.
        argPath = argPath.replace(/"/g, sep);
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
    // Validate the cwd before it reaches node-pty. An agent running in a
    // container/another machine can pass a path like /workspace/kordl that does
    // not exist on this host; node-pty's WindowsPtyAgent then throws "File not
    // found" as an UNCAUGHT exception and crashes the whole main process. Fall
    // back to a known-good directory instead.
    let resolvedCwd = extraOptionsFiltered.cwd || cwd || workingDirectory;
    if (!resolvedCwd || !isAbsolute(resolvedCwd) || !existsSync(resolvedCwd)) {
      resolvedCwd = cwd || (existsSync(workingDirectory) ? workingDirectory : homeDirectory);
    }
    const defaultOptions = Object.assign(
      {
        splitDirection: undefined,
        shell: profileCfg.shell,
        shellArgs: profileCfg.shellArgs && Array.from(profileCfg.shellArgs)
      },
      extraOptionsFiltered,
      {
        cwd: resolvedCwd,
        profile: extraOptionsFiltered.profile || profileName,
        uid
      }
    );
    const options = decorateSessionOptions(defaultOptions);
    // Guard the shell: an empty shell, or a profile whose binary is missing,
    // makes node-pty throw "File not found" → uncaught crash. Default to a real
    // shell that exists. (Bare names like "pwsh" are left alone — node-pty
    // resolves those via PATH.)
    if (!options.shell || (isAbsolute(options.shell) && !existsSync(options.shell))) {
      options.shell = fallbackShell();
      options.shellArgs = [];
    }
    const DecoratedSession = decorateSessionClass(Session);
    let session;
    try {
      session = new DecoratedSession(options);
    } catch (err) {
      // Last-resort recovery so a failed spawn never crashes the main process:
      // retry once with a guaranteed default shell + home cwd.
      console.error('[session] spawn failed; retrying with default shell:', (err as Error).message);
      options.shell = fallbackShell();
      options.shellArgs = [];
      options.cwd = homeDirectory;
      session = new DecoratedSession(options);
    }
    sessions.set(uid, session);
    return {session, options};
  }

  rpc.on('new', (extraOptions) => {
    let created;
    try {
      created = createSession(extraOptions);
    } catch (err) {
      // Even the fallback spawn failed — log and bail rather than crash the
      // main process with an uncaught exception (the new pane just won't open).
      console.error('[new] failed to create session:', err);
      return;
    }
    const {session, options} = created;

    sessions.set(options.uid, session);
    rpc.emit('session add', {
      rows: options.rows,
      cols: options.cols,
      uid: options.uid,
      splitDirection: options.splitDirection,
      splitPlacement: (extraOptions as any).splitPlacement,
      activeUid: options.activeUid ?? undefined,
      shell: session.shell,
      pid: session.pty ? session.pty.pid : null,
      profile: options.profile,
      groupUid: extraOptions.groupUid,
      url: extraOptions.url,
      cwd: options.cwd,
      isNewGroup: extraOptions.isNewGroup,
      isRestore: extraOptions.isRestore,
      lastCommand: extraOptions.lastCommand,
      prefillCommand: (extraOptions as any).prefillCommand,
      layoutPattern: (extraOptions as any).layoutPattern,
      shellState: (session as any).shellState,
      isAgentInitiated: (extraOptions as any).isAgentInitiated
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

    session.on('cwd', (cwd: string) => {
      updateSessionCwd(options.uid, cwd);
      rpc.emit('session cwd', {uid: options.uid, cwd});
    });

    session.on('shellstate', (shellState: any) => {
      rpc.emit('session shellstate', {uid: options.uid, shellState});
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
    updateSessionTabName(uid, tabName, true);
  });
  rpc.on(
    'session layout sync',
    (
      payload: Array<{
        rootGroupUid: string;
        order: number;
        active: boolean;
        panes: Array<{
          uid: string;
          splitLabel: string;
          isWeb: boolean;
          isAi: boolean;
          title: string;
          shellName: string;
          url?: string;
          active: boolean;
        }>;
      }>
    ) => {
      (window as any).tabCount = payload.length;
      let totalPanes = 0;
      payload.forEach((tab) => {
        totalPanes += tab.panes ? tab.panes.length : 0;
      });
      (window as any).paneCount = totalPanes;
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
  rpc.on('session set xterm title', ({uid, title, manual}: {uid: string; title: string; manual?: boolean}) => {
    // Only update window chrome — tab names come from renderer via 'session set tab name'
    // Update only the window TITLE. Do NOT override the taskbar icon per-session
    // — the window keeps the proper Hyperia icon set at creation (winOpts.icon).
    window.setTitle(title ? `${title} — Hyperia` : 'Hyperia');
  });
  rpc.on('split request vertical', (options: {activeUid?: string | null; profile?: string | null}) => {
    rpc.emit('split request vertical', options);
  });
  rpc.on('split request horizontal', (options: {activeUid?: string | null; profile?: string | null}) => {
    rpc.emit('split request horizontal', options);
  });
  rpc.on(
    'split web pane req',
    (options: {activeUid?: string | null; url?: string; direction?: 'HORIZONTAL' | 'VERTICAL'}) => {
      rpc.emit('split web pane req', options);
    }
  );
  rpc.on('clone request vertical', () => {
    rpc.emit('clone request vertical', undefined as any);
  });
  rpc.on('clone request horizontal', () => {
    rpc.emit('clone request horizontal', undefined as any);
  });
  // Same deal as above, grabbing the window titlebar when the window
  // is maximized on Windows results in unmaximize, without hitting any
  // app buttons
  const onGeometryChange = () => {
    rpc.emit('windowGeometry change', {isMaximized: window.isMaximized()});
    updateWindowBounds(window);
  };
  window.on('maximize', onGeometryChange);
  window.on('unmaximize', onGeometryChange);
  window.on('minimize', onGeometryChange);
  // Report OS pixel size to the sidecar on resize (debounced) + once at ready,
  // so terminal_status carries the live window dimensions.
  let _boundsT: ReturnType<typeof setTimeout> | null = null;
  window.on('resize', () => {
    if (_boundsT) clearTimeout(_boundsT);
    _boundsT = setTimeout(() => updateWindowBounds(window), 200);
  });
  window.once('ready-to-show', () => updateWindowBounds(window));
  window.on('restore', onGeometryChange);

  // Tear down any native web-pane views this window owns — their webContents are
  // NOT auto-destroyed, so skipping this leaks renderer processes.
  window.on('closed', () => destroyPanesForWindow(window));

  window.on('move', () => {
    const position = window.getPosition();
    rpc.emit('move', {bounds: {x: position[0], y: position[1]}});
  });
  let isClosingAndWaitingForSave = false;
  window.on('close', (e) => {
    // A real app quit (tray → Quit) must NOT be blocked by the save-on-close
    // preventDefault below — otherwise Electron aborts the quit and the app +
    // helper processes + stickies linger (the "Hyperia still running" bug). Let
    // the window close immediately when we're quitting.
    if ((app as {isQuitting?: boolean}).isQuitting) {
      return;
    }
    if (isClosingAndWaitingForSave) {
      return;
    }
    const tabCount = (window as any).tabCount || 1;
    const paneCount = (window as any).paneCount || 1;
    if (tabCount > 1 || paneCount > 1) {
      const message =
        tabCount > 1
          ? `Are you sure you want to close all ${tabCount} tabs?`
          : `Are you sure you want to close this tab with all ${paneCount} split panes?`;
      const detail =
        tabCount > 1
          ? 'This will close the entire window and terminate all active sessions.'
          : 'This will close the entire window and terminate all active sessions inside this tab.';

      const choice = dialog.showMessageBoxSync(window, {
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 1,
        title: 'Confirm Close',
        message,
        detail,
        cancelId: 1
      });
      if (choice !== 0) {
        e.preventDefault();
        return;
      }
    }
    e.preventDefault();
    isClosingAndWaitingForSave = true;
    (window as any).isClosing = true;
    rpc.emit('get-layout-state-req');
    // Failsafe: the close used to hang waiting for the renderer's
    // 'layout-state-reply' — if that never arrived the window stayed open and
    // you had to click close a SECOND time. Saving layout is best-effort; close
    // the window regardless after a short grace period.
    setTimeout(() => {
      if (isClosingAndWaitingForSave && !window.isDestroyed()) {
        deleteSessions();
        window.destroy();
      }
    }, 600);
  });

  rpc.on('layout-state-reply', (layoutState) => {
    try {
      let currentConfig: any = {};
      if (existsSync(cfgPath)) {
        currentConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));
      }
      currentConfig.savedLayoutState = layoutState;
      writeFileSync(cfgPath, JSON.stringify(currentConfig, null, 2), 'utf8');
      console.log('[window] Successfully saved layout state to hyperia.json');
    } catch (err) {
      console.error('[window] Failed to write layout state to hyperia.json:', err);
    }

    if (isClosingAndWaitingForSave) {
      deleteSessions();
      window.destroy();
    }
  });

  rpc.on('close', () => {
    window.close();
  });
  rpc.on('command', (command) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    execCommand(command, focusedWindow!);
  });
  rpc.on('session-cd', ({uid, path}) => {
    const result = executeSessionCd(uid, path, undefined, true);
    rpc.emit('session-cd-reply', { uid, ...result });
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
    try {
      const {protocol} = new URL(url);
      if (protocol === 'file:') {
        const path = fileURLToPath(url);
        rpc.emit('session data send', {uid: null, data: path, escaped: true});
      } else if (protocol === 'http:' || protocol === 'https:') {
        void shell.openExternal(url);
      }
    } catch {
      // malformed URL — ignore
    }
    return {action: 'deny'};
  });

  // When a <webview> is attached (e.g. a web pane), prevent it from opening
  // popup windows (OAuth flows, target="_blank" links) as new BrowserWindows.
  // Route them to the system browser instead.
  window.webContents.on('did-attach-webview', (_event, webviewContents) => {
    // Make this web pane's outgoing requests fingerprint as Chrome (UA + matching
    // sec-ch-ua client hints) so Cloudflare's challenge clears instead of looping.
    try {
      configureWebPaneSession(webviewContents.session);
    } catch (err) {
      console.error('[web-pane] header config failed:', err);
    }
    // Let the renderer reach this guest via @electron/remote too (zoom keys etc.).
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('@electron/remote/main').enable(webviewContents);
    } catch (err) {
      console.error('[ctxmenu] remote.enable(guest) failed:', err);
    }
    // Right-click menu for web panes, built in MAIN with the guest webContents
    // directly. (The renderer tried to reach it via @electron/remote's
    // webContents.fromId, which silently returned nothing — so there was no
    // in-page menu at all.) inspectElement docks DevTools at the bottom.
    webviewContents.on('context-menu', (_e: any, params: Electron.ContextMenuParams) => {
      const guestWc: Electron.WebContents = webviewContents as any;
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (params.misspelledWord) {
        if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
          for (const suggestion of params.dictionarySuggestions) {
            items.push({
              label: suggestion,
              click: () => {
                // Electron 41 dropped WebContents.replaceMisspelledWord. Right-
                // clicking a misspelled word selects it, so insertText replaces
                // that selection with the chosen suggestion.
                void guestWc.insertText(suggestion);
              }
            });
          }
        } else {
          items.push({
            label: 'No spelling suggestions',
            enabled: false
          });
        }
        items.push(
          {
            label: 'Add to Dictionary',
            click: () => {
              try {
                guestWc.session.addWordToSpellCheckerDictionary(params.misspelledWord);
              } catch (err) {
                console.error('[web-pane] failed to add word to dictionary:', err);
              }
            }
          },
          {type: 'separator'}
        );
      }
      items.push(
        {
          label: 'Back',
          enabled: guestWc.canGoBack(),
          click: () => {
            guestWc.goBack();
          }
        },
        {
          label: 'Forward',
          enabled: guestWc.canGoForward(),
          click: () => {
            guestWc.goForward();
          }
        },
        {
          label: 'Reload',
          click: () => {
            guestWc.reload();
          }
        },
        {type: 'separator'}
      );
      if (params.linkURL) {
        items.push(
          {label: 'Copy Link', click: () => require('electron').clipboard.writeText(params.linkURL)},
          {label: 'Open Link in Browser', click: () => void shell.openExternal(params.linkURL)},
          {type: 'separator'}
        );
      }
      items.push(
        {label: 'Copy', role: 'copy', enabled: !!params.editFlags?.canCopy},
        {label: 'Paste', role: 'paste', enabled: !!params.editFlags?.canPaste},
        {label: 'Select All', role: 'selectAll'},
        {type: 'separator'},
        {
          label: 'Find in page',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            // The guest webContents id matches what the renderer's
            // <webview>.getWebContentsId() returns, so the right web pane can
            // open its find bar.
            try {
              window.webContents.send('web-pane-find', (webviewContents as any).id);
            } catch (err) {
              console.error('web-pane-find send failed:', err);
            }
          }
        },
        {type: 'separator'},
        {
          label: 'Inspect',
          click: () => {
            try {
              // A <webview> guest has no window chrome to dock into, so
              // {mode:'bottom'} silently no-ops. Detach opens a real DevTools
              // window for the guest, which works. Open first, then inspect the
              // clicked element once DevTools is up.
              if (!guestWc.isDevToolsOpened()) {
                guestWc.openDevTools({mode: 'detach'});
                guestWc.once('devtools-opened', () => {
                  try {
                    guestWc.inspectElement(params.x, params.y);
                  } catch (err) {
                    console.error('inspectElement failed:', err);
                  }
                });
              } else {
                guestWc.inspectElement(params.x, params.y);
              }
            } catch (err) {
              console.error('Inspect failed:', err);
            }
          }
        },
        {type: 'separator'},
        {
          label: 'New Stickys',
          click: () => void ipcMain.emit('new-sticky', {})
        },
        {
          label: 'Search Stickys',
          click: () => void ipcMain.emit('search-stickies')
        }
      );
      Menu.buildFromTemplate(items).popup({window});
    });
    webviewContents.setWindowOpenHandler(({url}) => {
      // OAuth / login popups can't run inside an embedded browser — hand those
      // to the system browser.
      const isOAuth =
        /^https?:\/\/(accounts\.google\.|login\.microsoftonline\.|appleid\.apple\.|github\.com\/login|login\.yahoo\.|(www\.)?facebook\.com\/(login|dialog)|api\.twitter\.com\/oauth)/i.test(
          url
        );
      if (isOAuth) {
        void shell.openExternal(url);
        return {action: 'deny'};
      }
      // target="_blank" / window.open wants a new "tab" — but Hyperia has split
      // panes, not browser tabs. So tell the renderer to split DOWN and open the
      // link in a fresh web pane below the current one. (The guest webContents id
      // routes it to the right pane.)
      try {
        window.webContents.send('web-pane-open-split', (webviewContents as any).id, url);
      } catch (err) {
        console.error('web-pane-open-split send failed:', err);
        void shell.openExternal(url);
      }
      return {action: 'deny'};
    });
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
    // Piggyback pixel bounds — focus fires at launch, after the sidecar WS is
    // up, so terminal_status gets the window size even with no resize/maximize.
    updateWindowBounds(window);
  };

  window.on('focus', () => {
    updateFocusTime();
  });

  // Safety net: a fresh window may be focused before the sidecar WS connects,
  // so ready-to-show / focus bounds can be dropped. Resend a couple of times.
  setTimeout(() => updateWindowBounds(window), 1500);
  setTimeout(() => updateWindowBounds(window), 4000);

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
