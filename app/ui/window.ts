import {existsSync, readFileSync, writeFileSync, cpSync, statSync} from 'fs';
import {dirname, isAbsolute, join, normalize, sep, basename, extname} from 'path';
import {URL, fileURLToPath} from 'url';

import {app, BrowserWindow, shell, Menu, dialog, nativeImage, clipboard} from 'electron';
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
  executeSessionCd,
  updateWindowWebUrls,
  clearWindowWebUrls
} from '../bridge';
import {execCommand} from '../commands';
import {getDefaultProfile} from '../config';
import {initWebPaneManager, destroyPanesForWindow, setWindowWebPanesSuppressed} from '../web-pane-manager';
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

// Web panes spoof a Chrome User-Agent, but setting the UA *string* alone isn't
// enough — Chromium still emits `sec-ch-ua` client hints that carry the
// "Electron" brand. Cloudflare's managed challenge cross-checks the UA against
// those hints, so a Chrome UA paired with Electron client hints loops on
// "Just a moment…" forever. Rewrite the outgoing headers so UA AND client hints
// both say Google Chrome, consistently.
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
  // Register the WebContentsView IPC surface once (idempotent guard). Hands it
  // configureWebPaneSession so web-pane sessions fingerprint as Chrome.
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
      contextIsolation: false
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

  // #148: panes running a foreground program. TWO signals, UNIONED, because
  // neither alone is complete:
  //  (1) renderer 'session layout sync' → busyPanes (isTerminalBusy = OSC
  //      "running" OR an alt-screen TUI). MISSES an ssh pane running an INLINE
  //      remote agent (antigravity/codex/claude over ssh): the local shell looks
  //      idle and the agent isn't alt-screen, so the renderer sees nothing.
  //  (2) the sidecar's AUTHORITATIVE per-pane state (foreground process != shell,
  //      via OS process inspection) — this DOES see `ssh` running. Polled below.
  let busyPanes: Array<{name: string}> = [];
  let sidecarBusy: Array<{name: string}> = [];
  // Orphaned-session recovery. An orphan = a live PTY main still holds
  // (`sessions`) that the renderer's VISIBLE layout dropped — a renderer
  // crash/reload/desync loses the tab while the shell keeps running. We POLL for
  // them (reconcile against every 'session layout sync' → renderedUids) and
  // RECONNECT by re-emitting the session as a fresh tab bound to its EXISTING
  // live PTY. `sessionBornAt` gates just-created sessions (their sync lags);
  // `orphanSince`/`reattachedUids` debounce the auto sweep and stop a reattach
  // loop if the layout sync is slow to reflect the recovered tab.
  let renderedUids = new Set<string>();
  const sessionBornAt = new Map<string, number>();
  const orphanSince = new Map<string, number>();
  const reattachedUids = new Set<string>();
  const ORPHAN_GRACE_MS = 8000;
  const getActiveShellSessions = (): Array<{name: string}> => {
    const seen = new Set<string>();
    const out: Array<{name: string}> = [];
    for (const p of [...busyPanes, ...sidecarBusy]) {
      if (p.name && !seen.has(p.name)) {
        seen.add(p.name);
        out.push(p);
      }
    }
    return out;
  };
  (window as any).getActiveShellSessions = getActiveShellSessions;

  // Re-emit an orphaned session as a fresh tab bound to its EXISTING live PTY.
  // isRestore avoids re-running any prefill command; the new Term fits itself and
  // resizes the live PTY, so an ssh/agent you'd lost comes back interactive.
  const reattachSession = (uid: string, session: any) => {
    rpc.emit('session add', {
      rows: 24,
      cols: 80,
      uid,
      activeUid: undefined,
      shell: session.shell,
      pid: session.pty ? session.pty.pid : null,
      profile: session.profile,
      cwd: session.cwd,
      isNewGroup: true,
      isRestore: true
    });
  };
  // Live PTY sessions main holds that the visible layout doesn't show.
  const listOrphans = (minAgeMs: number): Array<[string, any]> => {
    const out: Array<[string, any]> = [];
    for (const [uid, session] of sessions) {
      if (renderedUids.has(uid)) continue;
      if (!session || (session as any).ended) continue;
      if (Date.now() - (sessionBornAt.get(uid) || 0) < minAgeMs) continue;
      out.push([uid, session]);
    }
    return out;
  };
  // Manual trigger ("Recover Panes" menu) — bring back everything not visible now.
  (window as any).recoverPanes = (): number => {
    const orphans = listOrphans(3000);
    for (const [uid, session] of orphans) {
      reattachSession(uid, session);
      reattachedUids.add(uid);
    }
    console.log(`[recover] manual re-attach of ${orphans.length} orphaned pane(s)`);
    return orphans.length;
  };
  // Auto sweep (stop-the-leak-at-source): a session that stays orphaned past the
  // grace window is reattached ONCE — a legit pane close DESTROYS its session
  // (it leaves `sessions`), so only true crash/desync orphans ever reach here.
  const reconcileOrphans = () => {
    for (const [uid, session] of listOrphans(ORPHAN_GRACE_MS)) {
      if (reattachedUids.has(uid)) continue;
      const since = orphanSince.get(uid);
      if (since === undefined) {
        orphanSince.set(uid, Date.now());
        continue;
      }
      if (Date.now() - since < ORPHAN_GRACE_MS) continue;
      reattachSession(uid, session);
      reattachedUids.add(uid);
      orphanSince.delete(uid);
      console.log(`[recover] auto re-attached orphan ${uid.slice(0, 8)}`);
    }
  };
  const reconcileTimer = setInterval(reconcileOrphans, 5000);
  window.on('closed', () => clearInterval(reconcileTimer));

  // Poll the sidecar for THIS window's running panes — the signal the renderer
  // heuristic can't see (ssh→remote agent). Cheap anonymous GET; every 2s.
  const pollSidecarBusy = async () => {
    try {
      const port = process.env.HYPERIA_PORT || '9800';
      const res = await fetch(`http://localhost:${port}/api/status`);
      const data: any = await res.json();
      const localUids = new Set(sessions.keys());
      const found: Array<{name: string}> = [];
      for (const w of data?.windows || []) {
        for (const t of w?.tabs || []) {
          for (const p of t?.panes || []) {
            if (p?.state === 'running' && localUids.has(p.paneId)) {
              found.push({name: p.name || p.title || p.process || 'a shell'});
            }
          }
        }
      }
      sidecarBusy = found;
    } catch {
      /* sidecar unreachable → fall back to the renderer signal only */
    }
  };
  const sidecarBusyTimer = setInterval(() => void pollSidecarBusy(), 2000);
  window.on('closed', () => clearInterval(sidecarBusyTimer));

  // Set when the renderer closes this window because the user exited its LAST
  // pane (which already passed the per-pane guard) — main must not re-prompt.
  let skipNextCloseConfirm = false;

  // #148: ask the user to confirm a close via the in-app (styled) modal instead
  // of a native OS dialog. rpc round-trip: emit 'close-confirm', the renderer
  // ACKs immediately (so we know the modal is up) then replies with the choice.
  // FAILSAFE: if no ACK within 1s the modal isn't reachable → native dialog, so
  // the confirm ALWAYS happens and the close never gets stuck.
  let closeConfirmSeq = 0;
  const pendingClose = new Map<number, {finish: (ok: boolean) => void; ackTimer: ReturnType<typeof setTimeout>}>();
  const confirmCloseModal = (payload: {
    scope: 'window' | 'quit' | 'tab';
    names: string[];
    tabCount?: number;
    paneCount?: number;
  }): Promise<boolean> => {
    return new Promise((resolve) => {
      if (window.isDestroyed()) {
        resolve(true);
        return;
      }
      const id = ++closeConfirmSeq;
      let settled = false;
      // Native web-pane views paint ABOVE the renderer DOM, so a crisp web pane
      // would cover the (DOM) close-confirm modal — the terminal dims but the
      // modal is hidden behind the page. Pull the window's web views off-screen
      // while the modal is up; restore them when the choice is made.
      if (!window.isDestroyed()) setWindowWebPanesSuppressed(window, true);
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (!window.isDestroyed()) setWindowWebPanesSuppressed(window, false);
        const e = pendingClose.get(id);
        if (e) clearTimeout(e.ackTimer);
        pendingClose.delete(id);
        resolve(ok);
      };
      const n = payload.names;
      const nativeFallback = () => {
        if (settled || window.isDestroyed()) {
          finish(true);
          return;
        }
        const verb = payload.scope === 'quit' ? 'Quit' : 'Close';
        const choice = dialog.showMessageBoxSync(window, {
          type: 'question',
          buttons: [payload.scope === 'quit' ? 'Quit' : 'Close window', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Active processes running',
          message:
            n.length === 0
              ? 'Close anyway?'
              : n.length === 1
                ? `A pane is still running “${n[0]}”.`
                : `${n.length} panes are still running (${n.join(', ')}).`,
          detail: `This will stop ${n.length === 1 ? 'it' : 'them'}. ${verb} anyway?`
        });
        finish(choice === 0);
      };
      const ackTimer = setTimeout(nativeFallback, 1000);
      pendingClose.set(id, {finish, ackTimer});
      rpc.emit('close-confirm', {id, scope: payload.scope, names: n, tabCount: payload.tabCount, paneCount: payload.paneCount});
    });
  };
  (window as any).confirmCloseModal = confirmCloseModal;
  rpc.on('close-confirm-ack', ({id}) => {
    // Modal is on screen → cancel the native fallback, wait for the user's reply.
    const e = pendingClose.get(id);
    if (e) clearTimeout(e.ackTimer);
  });
  rpc.on('close-confirm-reply', ({id, ok}) => {
    pendingClose.get(id)?.finish(ok);
  });

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
    sessionBornAt.set(options.uid, Date.now());
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
  // Web-pane URL snapshot from the renderer's web-url middleware (#84) —
  // {termGroupUid → url} for this window, kept bridge-side so layout save
  // (#82) reads URLs without a close-time renderer roundtrip.
  rpc.on('session web url', ({urls}: {urls: Record<string, string>}) => {
    updateWindowWebUrls(window.id, urls || {});
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
          busy: boolean;
        }>;
      }>
    ) => {
      (window as any).tabCount = payload.length;
      let totalPanes = 0;
      const busy: Array<{name: string}> = [];
      payload.forEach((tab) => {
        totalPanes += tab.panes ? tab.panes.length : 0;
        tab.panes?.forEach((p) => {
          if (p.busy) busy.push({name: p.shellName || p.title || 'a shell'});
        });
      });
      (window as any).paneCount = totalPanes;
      busyPanes = busy;
      // Track which sessions the renderer currently shows (orphan detection). A
      // uid that's visible again clears its recovery state so a FUTURE orphaning
      // can recover it.
      renderedUids = new Set<string>();
      payload.forEach((tab) => tab.panes?.forEach((p) => renderedUids.add(p.uid)));
      renderedUids.forEach((uid) => {
        orphanSince.delete(uid);
        reattachedUids.delete(uid);
      });
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
  // Right-clicking a URL in a terminal shows link actions ONLY (#15) — no
  // terminal menu. Terminal output isn't editable, so there's no "Edit Link"
  // (unlike stickies).
  rpc.on('open link context menu', ({link}) => {
    if (!link) return;
    Menu.buildFromTemplate([
      {label: 'Open Link in Browser', click: () => void shell.openExternal(link)},
      {label: 'Open Link in Web Pane', click: () => rpc.emit('open web pane req', {url: link})},
      {label: 'Copy Link', click: () => clipboard.writeText(link)}
    ]).popup({window});
  });
  rpc.on('open edit context menu', () => {
    // Standard editing menu for real text inputs (custom-shell modal fields, URL
    // bar). The roles act on the focused input in this window's webContents.
    Menu.buildFromTemplate([
      {role: 'cut'},
      {role: 'copy'},
      {role: 'paste'},
      {type: 'separator'},
      {role: 'selectAll'}
    ]).popup({window});
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
  window.on('closed', () => {
    destroyPanesForWindow(window);
    clearWindowWebUrls(window.id);
  });

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
    if (skipNextCloseConfirm) {
      // Renderer already confirmed at the pane level (last-pane exit).
      skipNextCloseConfirm = false;
    } else {
      // Not confirmed yet — decide asynchronously via the in-app modal (which
      // falls back to a native dialog if the renderer can't answer), then
      // re-enter (skipNextCloseConfirm) to save layout + destroy.
      e.preventDefault();
      void (async () => {
        const active = getActiveShellSessions();
        const tabCount = (window as any).tabCount || 1;
        const paneCount = (window as any).paneCount || 1;
        let ok = true;
        if (active.length > 0 || tabCount > 1 || paneCount > 1) {
          ok = await confirmCloseModal({
            scope: 'window',
            names: active.map((a) => a.name),
            tabCount,
            paneCount
          });
        }
        if (ok && !window.isDestroyed()) {
          skipNextCloseConfirm = true;
          window.close();
        }
      })();
      return;
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
  // The renderer exited the window's LAST pane (already past the per-pane guard);
  // close without re-prompting about active processes. (#148)
  rpc.on('close-no-confirm', () => {
    skipNextCloseConfirm = true;
    window.close();
  });
  // #148: the renderer wants to close a TAB whose panes are running foreground
  // programs — confirm via the in-app modal (native fallback) and echo back
  // 'close-tab-confirmed' if the user proceeds.
  rpc.on('confirm-close-tab', ({uid, names}) => {
    void (async () => {
      const ok = await confirmCloseModal({scope: 'tab', names: names && names.length ? names : []});
      if (ok) {
        rpc.emit('close-tab-confirmed', {uid});
      }
    })();
  });
  rpc.on('command', (command) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    execCommand(command, focusedWindow!);
  });
  rpc.on('session-cd', ({uid, path}) => {
    const result = executeSessionCd(uid, path, undefined, true);
    rpc.emit('session-cd-reply', { uid, ...result });
  });
  // Drag-and-drop: copy OS files dropped onto an IDLE terminal pane into that
  // pane's cwd. The renderer gates on shell state (idle) + a known cwd and sends
  // absolute source paths; we copy collision-safely (never overwrite — a name
  // clash gets a " (n)" suffix) and report back for a toast. Files and folders
  // (recursive) both work.
  rpc.on('pane copy files', ({uid, cwd, paths}) => {
    const isDir = (p?: string | null): p is string => !!p && existsSync(p) && statSync(p).isDirectory();
    try {
      // Resolve the pane's directory authoritatively so the feature works even
      // without shell integration: renderer hint → the session's tracked cwd →
      // the LIVE cwd of the shell process (native-process-working-directory).
      let dir = isDir(cwd) ? cwd : '';
      if (!dir) {
        const session = sessions.get(uid);
        if (isDir(session?.cwd)) dir = session!.cwd;
        else if (session?.pty?.pid) {
          const live = getWorkingDirectoryFromPID(session.pty.pid);
          if (isDir(live)) dir = live;
        }
      }
      if (!dir) {
        rpc.emit('pane copy files done', {uid, ok: false, dir: cwd || '', count: 0, error: "couldn't determine the pane's directory"});
        return;
      }
      // A folder drag can enumerate the folder AND its descendants as separate
      // top-level entries (Chromium expands directory drops into
      // dataTransfer.files) — copying each one then splatters the folder's
      // contents into the cwd root NEXT TO the folder copy. Keep only ROOT
      // paths: anything inside another dropped path already comes along with
      // the recursive copy of its parent.
      const candidates = (paths || []).filter((p): p is string => !!p && existsSync(p));
      const normPath = (p: string) => {
        const n = p.replace(/[\\/]+$/, '');
        return process.platform === 'win32' ? n.toLowerCase() : n;
      };
      const rootPaths = candidates.filter((p) => {
        const np = normPath(p);
        return !candidates.some((other) => {
          if (other === p) return false;
          const no = normPath(other);
          return np !== no && (np.startsWith(`${no}\\`) || np.startsWith(`${no}/`));
        });
      });
      const names: string[] = [];
      for (const src of rootPaths) {
        try {
          const srcBase = basename(src);
          let dest = join(dir, srcBase);
          if (existsSync(dest)) {
            const ext = extname(srcBase);
            const stem = ext ? srcBase.slice(0, -ext.length) : srcBase;
            let n = 1;
            do {
              dest = join(dir, `${stem} (${n})${ext}`);
              n += 1;
            } while (existsSync(dest) && n < 1000);
          }
          cpSync(src, dest, {recursive: true, errorOnExist: false});
          names.push(basename(dest));
        } catch (err) {
          console.warn('pane copy files: failed to copy', src, err);
        }
      }
      rpc.emit('pane copy files done', {uid, ok: names.length > 0, dir, count: names.length, names});
    } catch (err) {
      rpc.emit('pane copy files done', {uid, ok: false, dir: cwd || '', count: 0, error: (err as Error)?.message || String(err)});
    }
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
      sessionBornAt.delete(key);
      orphanSince.delete(key);
      reattachedUids.delete(key);
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

  // Web panes render via native WebContentsViews (app/web-pane-manager.ts), which
  // owns their context menu, OAuth punting, target="_blank" splits, and session
  // config. The legacy <webview> guest wiring (did-attach-webview) is gone.

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
