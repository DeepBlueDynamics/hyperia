// eslint-disable-next-line import/order
import {cfgPath} from './config/paths';

// Print diagnostic information for a few arguments instead of running Hyperia.
if (['--help', '-v', '--version'].includes(process.argv[1])) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {version} = require('./package');
  console.log(`Hyperia version ${version}`);
  console.log('Hyperia does not accept any command line arguments. Please modify the config file instead.');
  console.log(`Hyperia configuration file located at: ${cfgPath}`);
  process.exit();
}

// Enable remote module
// eslint-disable-next-line import/order
import {initialize as remoteInitialize} from '@electron/remote/main';
remoteInitialize();

// set up config
// eslint-disable-next-line import/order
import * as config from './config';
config.setup();

// Native
import {spawn} from 'child_process';
import type {ChildProcess} from 'child_process';
import {resolve} from 'path';

// Packages
import {app, BrowserWindow, Menu, screen, ipcMain} from 'electron';

// Windows app identity — set FIRST (before app.name/setName, the userData pin, or
// any window/tray), but ONLY in a packaged build. Critical: in dev, `yarn start`
// runs node_modules\electron\dist\electron.exe; if THAT process claimed the same
// stable AUMID, Windows would cache "com.deepbluedynamics.hyperia → electron.exe"
// (the GENERIC Electron icon), and the packaged app would inherit that poisoned
// icon mapping. Gating on app.isPackaged means only the real installed exe ever
// owns the AUMID, so Windows maps it to OUR icon. Stable (== electron-builder
// appId) so Start-menu search + taskbar pins persist across updates.
if (process.platform === 'win32' && app.isPackaged) {
  try {
    app.setAppUserModelId('com.deepbluedynamics.hyperia');
  } catch {
    /* non-fatal */
  }
} else if (process.platform === 'win32') {
  // Dev (`yarn start`) gets its OWN AUMID — never the stable one (poison, see
  // above) and never Electron's default ("electron.app.Electron"): the default
  // makes Windows mint Electron.lnk / jump-list entries whose generic icon
  // bleeds back into the shell's icon caches.
  try {
    app.setAppUserModelId('com.deepbluedynamics.hyperia.dev');
  } catch {
    /* non-fatal */
  }
}

// Self-healing icon-poison sweep: Electron's Windows toast-notification path
// SELF-INSTALLS a Start Menu shortcut carrying its AUMID (toasts require one).
// In dev that materializes as "Electron.lnk" → node_modules\electron\dist\
// electron.exe, whose generic icon contaminates the shell icon caches. Any
// launch that finds one pointing at a dev electron.exe deletes it on sight.
if (process.platform === 'win32') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {shell: electronShell} = require('electron');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {unlinkSync} = require('fs');
    const lnk = resolve(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Electron.lnk');
    const target = String(electronShell.readShortcutLink(lnk).target || '');
    if (/node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$/i.test(target)) {
      unlinkSync(lnk);
      console.warn('[win-icon] removed poisonous Electron.lnk (dev electron target):', target);
    }
  } catch {
    /* no Electron.lnk — nothing to heal */
  }
}

app.name = 'Hyperia';
app.setName('Hyperia');

// Pin Electron's userData directory to a STABLE path named "Hyperia" (the product
// name). Electron defaults userData to %APPDATA%/<app.name>; pinning it explicitly
// keeps it constant regardless of any future display-name tweaks (issue #127).
try {
  app.setPath('userData', resolve(app.getPath('appData'), 'Hyperia'));
} catch (e) {
  console.warn('[userData] failed to pin stable path:', e);
}

// A broken stdout/stderr pipe must NEVER crash the main process. When Hyperia is
// launched detached (or the parent terminal/pipe that captured its output
// closes), a later console.* write throws an uncaught EPIPE — which Electron
// surfaces as a fatal "A JavaScript error occurred in the main process" dialog
// (seen via the sidecar-stderr logger). Swallow EPIPE on the std streams so
// logging can never take the app down; re-throw anything else.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err && err.code === 'EPIPE') {
      return;
    }
    throw err;
  });
}

import isDev from 'electron-is-dev';
import {gitDescribe} from 'git-describe';
import parseUrl from 'parse-url';

import {startBridge, stopBridge, sendAppFocus} from './bridge';
import {initHyperia} from './ghost';
import * as AppMenu from './menus/menu';
import {initTray, destroyTray} from './notify';
import * as plugins from './plugins';
import {initSettings} from './settings';
import {initSticky} from './sticky';
import {SYSTEM_TOKEN} from './system-token';
import {newWindow} from './ui/window';
import {installCLI} from './utils/cli-install';
import * as windowUtils from './utils/window-utils';
import {restoreFor} from './window-state';
import {saveLastSession, readLastSessionForBoot, restoreWorkspace, clearLegacySavedLayoutState} from './workspace';

// Electron's DEFAULT uncaught-exception behavior is a BLOCKING modal error
// dialog in the main process — one bad config value (an unparseable color)
// threw on every config change, queued a dialog per throw, and froze the
// whole app until each was clicked away. Catch instead: log to disk, surface
// ONE non-blocking OS notification per burst, keep running.
{
  const errLogPath = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pathModule = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {homedir} = require('os') as typeof import('os');
    return pathModule.join(homedir(), '.hyperia', 'logs', 'main-errors.log');
  };
  let lastNotified = 0;
  const handle = (kind: string) => (err: unknown) => {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    console.error(`[main:${kind}]`, msg);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {appendFileSync, mkdirSync} = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pathModule = require('path') as typeof import('path');
      const p = errLogPath();
      mkdirSync(pathModule.dirname(p), {recursive: true});
      appendFileSync(p, `${new Date().toISOString()} [${kind}] ${msg}\n`);
    } catch {
      /* logging must never throw */
    }
    const now = Date.now();
    if (now - lastNotified > 10000) {
      lastNotified = now;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {Notification} = require('electron') as typeof import('electron');
        new Notification({
          title: 'Hyperia hit an internal error (still running)',
          body: `${String(msg).split('\n')[0].slice(0, 120)}\nDetails: ~/.hyperia/logs/main-errors.log`
        }).show();
      } catch {
        /* headless or too early — the log still has it */
      }
    }
  };
  process.on('uncaughtException', handle('uncaughtException'));
  process.on('unhandledRejection', handle('unhandledRejection'));
}

const windowSet = new Set<BrowserWindow>([]);

// --- Sidecar process (Rust agent engine, MCP) ---
let sidecarProcess: ChildProcess | null = null;
// Overridable so a dev build (spawned or external) can run beside an installed
// Hyperia that owns 9800 — same var the sidecar and shell-pane URL already use.
const SIDECAR_PORT = Number(process.env.HYPERIA_PORT) || 9800;

// Pulse UI bridge. The renderer can't hold SYSTEM_TOKEN (kept off the renderer
// for the same reason it's off PTYs), so it asks main to call the consent-gated
// pulse endpoints as System — the human is the authority, so this bypasses the
// agent consent prompt. Token never leaves the main process.
async function pulseFetch(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<string> {
  try {
    const res = await fetch(`http://localhost:${SIDECAR_PORT}${apiPath}`, {
      method,
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${SYSTEM_TOKEN}`},
      body: body == null ? undefined : JSON.stringify(body)
    });
    return await res.text();
  } catch (e) {
    return JSON.stringify({ok: false, error: String(e)});
  }
}
ipcMain.handle('pulse:set', (_e, body) => pulseFetch('POST', '/api/pulse/set', body));
ipcMain.handle('pulse:clear', (_e, body) => pulseFetch('POST', '/api/pulse/clear', body));
ipcMain.handle('pulse:pause', (_e, body) => pulseFetch('POST', '/api/pulse/pause', body));
ipcMain.handle('pulse:status', () => pulseFetch('GET', '/api/pulse/status'));

function findSidecarBinary(): string | null {
  const exeDir = process.platform === 'win32' ? resolve(process.execPath, '..') : __dirname;
  const resDir = process.resourcesPath || resolve(exeDir, 'resources');
  const sidecarName = process.platform === 'win32' ? 'hyperia-sidecar.exe' : 'hyperia-sidecar';
  const candidates = [
    resolve(resDir, 'sidecar', sidecarName),
    resolve(__dirname, '../../sidecar/target/release', sidecarName),
    resolve(__dirname, '../../sidecar/target/debug', sidecarName),
    resolve(__dirname, '../sidecar/target/release', sidecarName),
    resolve(__dirname, '../sidecar/target/debug', sidecarName),
    resolve(exeDir, '../../sidecar/target/release', sidecarName),
    resolve(exeDir, '../../sidecar/target/debug', sidecarName),
    resolve(exeDir, 'sidecar', sidecarName),
    resolve(exeDir, sidecarName)
  ];

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('fs').accessSync(candidate);
      return candidate;
    } catch {
      // not found
    }
  }

  isDev && console.log('[sidecar] Binary not found. Checked:');
  isDev && candidates.forEach((c) => console.log(`  ${c}`));
  return null;
}

function killExistingSidecars(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-shadow
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'win32'
        ? spawn('taskkill', ['/f', '/im', 'hyperia-sidecar.exe'])
        : spawn('pkill', ['-f', 'hyperia-sidecar']);
    cmd.on('close', () => {
      if (process.platform !== 'win32') {
        setTimeout(resolve, 800);
        return;
      }
      // Poll until no more sidecar processes are running (max 4s)
      let attempts = 0;
      const poll = () => {
        const check = spawn('tasklist', ['/fi', 'IMAGENAME eq hyperia-sidecar.exe', '/fo', 'csv', '/nh']);
        let out = '';
        check.stdout?.on('data', (d: Buffer) => {
          out += d.toString();
        });
        check.on('close', () => {
          if (!out.includes('hyperia-sidecar') || attempts++ >= 20) {
            resolve();
          } else {
            setTimeout(poll, 200);
          }
        });
        check.on('error', () => resolve());
      };
      setTimeout(poll, 200);
    });
    cmd.on('error', () => resolve());
  });
}

// Topology A (container deploy): when "use external sidecar" is set, Hyperia
// does NOT spawn or kill its own sidecar. An externally-managed sidecar (e.g.
// the Docker container in deploy/) owns port 9800; the bridge just connects to
// it. Toggle via the HYPERIA_USE_EXTERNAL_SIDECAR env var or the
// `useExternalSidecar` config flag. See deploy/hyperia-docker-deployment-spec.md §11.2.
function useExternalSidecar(): boolean {
  const env = process.env.HYPERIA_USE_EXTERNAL_SIDECAR;
  if (env && /^(1|true|yes|on)$/i.test(env.trim())) {
    return true;
  }
  try {
    return config.getConfig().useExternalSidecar === true;
  } catch {
    return false;
  }
}

async function spawnSidecar() {
  // External-sidecar mode: do not spawn or kill anything — leave port 9800 to
  // the externally-managed sidecar. startBridge() still runs after this resolves
  // and connects to it (it auto-reconnects until the container is up).
  if (useExternalSidecar()) {
    console.log(
      `[sidecar] External sidecar mode — not spawning; bridge will connect to the externally-managed sidecar on port ${SIDECAR_PORT}`
    );
    return;
  }
  const sidecarPath = findSidecarBinary();
  if (!sidecarPath) return;

  isDev && console.log(`[sidecar] __dirname = ${__dirname}`);

  // Kill any existing sidecar before spawning
  await killExistingSidecars();

  // Hand per-run/internal values to the sidecar via the CHILD's env only — NOT
  // process.env. If the system token were on process.env, every PTY the
  // terminal spawns would inherit it (app/session.ts → getDecoratedEnv) and any
  // shell in any pane could read it and bypass ALL permission enforcement.
  //
  // HYPERIA_CONFIG_PATH is the one shared config file Electron already resolved
  // (including XDG paths and the dev repo-local override). The sidecar must use
  // this exact path for settings writes so Electron's existing chokidar reload
  // sees the change.
  isDev && console.log(`[sidecar] Spawning: ${sidecarPath} --port ${SIDECAR_PORT}`);
  sidecarProcess = spawn(sidecarPath, ['--port', String(SIDECAR_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HYPERIA_SYSTEM_TOKEN: SYSTEM_TOKEN, HYPERIA_CONFIG_PATH: cfgPath}
  });

  sidecarProcess.stdout?.on('data', (data: Buffer) => {
    isDev && console.log(`[sidecar] ${data.toString().trim()}`);
  });
  sidecarProcess.stderr?.on('data', (data: Buffer) => {
    // Always log sidecar stderr so panics/errors are visible
    const msg = data.toString().trim();
    if (msg) console.error(`[sidecar] ${msg}`);
  });
  sidecarProcess.on('exit', (code: number | null) => {
    console.log(`[sidecar] Exited with code ${code}`);
    sidecarProcess = null;
    // Auto-restart only on crash (non-zero, non-null exit).
    // Code 0 = clean exit (another instance running, port conflict) — don't loop.
    if (!stopped && code !== 0) {
      console.log('[sidecar] Auto-restarting in 2s...');
      setTimeout(() => {
        if (!stopped) void spawnSidecar();
      }, 2000);
    }
  });
}

let stopped = false;

function killSidecar() {
  stopped = true; // prevent auto-restart
  if (sidecarProcess) {
    console.log('[sidecar] Shutting down');
    try {
      sidecarProcess.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    const pid = sidecarProcess.pid;
    setTimeout(() => {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
    }, 2000);
    sidecarProcess = null;
  }
}

// expose to plugins
app.config = config;
app.plugins = plugins;
app.getWindows = () => new Set([...windowSet]); // return a clone

// function to retrieve the last focused window in windowSet;
// added to app object in order to expose it to plugins.
app.getLastFocusedWindow = () => {
  if (!windowSet.size) {
    return null;
  }
  return Array.from(windowSet).reduce((lastWindow, win) => {
    return win.focusTime > lastWindow.focusTime ? win : lastWindow;
  });
};

// GPU acceleration (see GPU.md)
isDev && console.log('Enabling GPU acceleration');
app.commandLine.appendSwitch('ignore-gpu-blacklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers');

if (isDev) {
  console.log('running in dev mode');

  // Override default appVersion which is set from package.json
  gitDescribe({customArguments: ['--tags']}, (error: any, gitInfo: {raw: string}) => {
    if (!error) {
      app.setVersion(gitInfo.raw);
    }
  });
}

const url = `file://${resolve(isDev ? __dirname : app.getAppPath(), 'index.html')}`;
isDev && console.log('electron will open', url);

async function installDevExtensions(isDev_: boolean) {
  if (!isDev_) {
    return [];
  }
  const {default: installer, REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS} = await import('electron-devtools-installer');

  const extensions = [REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS];
  const forceDownload = Boolean(process.env.UPGRADE_EXTENSIONS);

  return Promise.all(
    extensions.map((extension) =>
      installer(extension, {
        forceDownload,
        loadExtensionOptions: {allowFileAccess: true}
      }).catch((err: Error) => {
        isDev && console.warn(`Failed to install devtools extension: ${err.message}`);
      })
    )
  );
}

// Single instance lock — prevent duplicate tray icons and sidecar spawns.
// HARD exit for the loser: app.quit() is async and the losing instance kept
// EXECUTING its init — including spawnSidecar's taskkill of the WINNER's
// sidecar — before actually quitting. That mutual sidecar-squash is what
// made duplicate launches flash/restart/rotate panes. app.exit() is
// synchronous and runs nothing further.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
  process.exit(0); // belt-and-suspenders: nothing below may run in the loser
}
app.on('second-instance', () => {
  // Stale-instance handover: a second launch right after an update usually
  // means WE are the old binary — the installer replaced the files on disk
  // under this running process (tray keep-alive outlives windows), we still
  // hold the single-instance lock, and any window WE open now renders as a
  // black frameless rectangle (our renderer assets are gone). Re-read the
  // on-disk version; if it isn't ours, honor the user's launch: relaunch
  // (spawns the NEW binary) and exit to release the lock.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {readFileSync} = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pathModule = require('path') as typeof import('path');
    const diskPkg = JSON.parse(readFileSync(pathModule.join(app.getAppPath(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    if (diskPkg?.version && diskPkg.version !== app.getVersion()) {
      console.log(
        `[update] on-disk v${diskPkg.version} != running v${app.getVersion()} — handing over to the new binary`
      );
      app.relaunch();
      app.exit(0);
      return;
    }
  } catch {
    /* unreadable (mid-install?) — fall through to normal behavior */
  }
  const win = (app as any).getLastFocusedWindow?.();
  if (win) {
    if (win.isMinimized()) win.restore();

    win.focus();
  } else {
    // All windows were closed — open a new one

    (app as any).createWindow?.();
  }
});

// macOS: after a "drag to Applications" install, the .dmg stays mounted as a
// /Volumes/Hyperia… volume. When we're running from a completed install (in
// /Applications — NOT off the DMG), eject any leftover Hyperia DMG so the user
// doesn't have to. No-op on Windows/Linux, when nothing is mounted, or when we
// are still running from the DMG itself.
function ejectInstallDmgOnMac(): void {
  if (process.platform !== 'darwin') return;
  try {
    const exePath = process.execPath; // …/Hyperia.app/Contents/MacOS/Hyperia
    if (!exePath.startsWith('/Applications/')) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {execFile} = require('child_process');
    let vols: string[] = [];
    try {
      vols = fs.readdirSync('/Volumes');
    } catch {
      return;
    }
    for (const v of vols) {
      if (!/^Hyperia/i.test(v)) continue;
      const volPath = `/Volumes/${v}`;
      if (exePath.startsWith(volPath)) continue; // never eject what we're running from
      try {
        if (fs.existsSync(`${volPath}/Hyperia.app`)) {
          execFile('hdiutil', ['eject', volPath], (err: unknown) => {
            if (err) console.error('[install] hdiutil eject failed:', err);
          });
        }
      } catch {
        /* skip this volume, keep going */
      }
    }
  } catch (err) {
    console.error('[install] DMG eject check failed:', err);
  }
}

app.on('ready', () => {
  // macOS: tidy up a leftover install DMG once we're running from /Applications.
  ejectInstallDmgOnMac();

  // System tray icon
  initTray();

  // Sticky notes
  initSticky();

  // Settings chat window
  initSettings();

  // Ghost agent window
  initHyperia();

  // Launch sidecar (agent engine, MCP)
  // Kill any stale sidecar on our port, then spawn fresh, then connect bridge
  void spawnSidecar().then(() => {
    // Connect bridge to sidecar (auto-reconnects until connected)
    startBridge(SIDECAR_PORT);
  });

  // Track OS-foreground so the sidecar's human-location report knows whether the
  // human is actually in Hyperia or off in another app (e.g. Chrome). On blur we
  // settle briefly, then report true only if SOME Hyperia window is still focused
  // (covers alt-tabbing between Hyperia windows vs. leaving the app entirely).
  app.on('browser-window-focus', () => sendAppFocus(true));
  app.on('browser-window-blur', () => {
    setTimeout(() => sendAppFocus(BrowserWindow.getAllWindows().some((w) => w.isFocused())), 60);
  });

  void installDevExtensions(isDev)
    .then(() => {
      function createWindow(
        fn?: (win: BrowserWindow) => void,
        options: {size?: [number, number]; position?: [number, number]} = {},
        profileName: string = config.getDefaultProfile()
      ) {
        const cfg = plugins.getDecoratedConfig(profileName);

        const winSet = config.getWin();
        let [startX, startY] = winSet.position;

        let [width, height] = options.size ? options.size : cfg.windowSize || winSet.size;

        const winPos = options.position;

        // Open the new window roughly the height of the header away from the
        // previous window. This also ensures in multi monitor setups that the
        // new terminal is on the correct screen.
        const focusedWindow = BrowserWindow.getFocusedWindow() || app.getLastFocusedWindow();
        // In case of options defaults position and size, we should ignore the focusedWindow.
        if (winPos !== undefined) {
          [startX, startY] = winPos;
        } else if (focusedWindow) {
          const points = focusedWindow.getPosition();
          const currentScreen = screen.getDisplayNearestPoint({
            x: points[0],
            y: points[1]
          });

          const biggestX = points[0] + 100 + width - currentScreen.bounds.x;
          const biggestY = points[1] + 100 + height - currentScreen.bounds.y;

          if (biggestX > currentScreen.size.width) {
            startX = 50;
          } else {
            startX = points[0] + 34;
          }
          if (biggestY > currentScreen.size.height) {
            startY = 50;
          } else {
            startY = points[1] + 34;
          }
        }

        if (!windowUtils.positionIsValid([startX, startY])) {
          [startX, startY] = config.windowDefaults.windowPosition;
        }

        // For the first window of the session, restore last-saved bounds + chrome
        // (maximize / fullscreen). Multi-display aware: if the saved display is
        // gone, the helper falls back to a visible default. Subsequent windows
        // fall through to the existing "spawn next to focused" offset above so
        // they don't stomp the saved state.
        let stateAttach: ((w: BrowserWindow) => void) | null = null;
        if (windowSet.size === 0) {
          const restore = restoreFor({width, height, x: startX, y: startY}, Boolean(options.size || cfg.windowSize));
          width = restore.opts.width;
          height = restore.opts.height;
          if (typeof restore.opts.x === 'number') startX = restore.opts.x;
          if (typeof restore.opts.y === 'number') startY = restore.opts.y;
          stateAttach = restore.attach;
        }

        const hwin = newWindow({width, height, x: startX, y: startY}, cfg, fn, profileName);
        windowSet.add(hwin);
        if (stateAttach) stateAttach(hwin);
        void hwin.loadURL(url);

        // the window can be closed by the browser process itself
        hwin.on('close', () => {
          if ((hwin as any).isClosing || (app as any).isQuitting) {
            hwin.clean();
            windowSet.delete(hwin);
          }
        });

        return hwin;
      }

      // expose to plugins (assigned before boot restore — restoreWorkspace
      // creates its windows through app.createWindow)
      app.createWindow = createWindow;

      // Boot restore (#171/#83): when a 'last-session' workspace exists,
      // reopen the WHOLE previous session — every window, with geometry —
      // through the same additive restore pipeline named restores use. Any
      // problem (no file, corrupt, future version) falls back to one fresh
      // window; a leftover legacy savedLayoutState blob is retired so the
      // per-window init hook can't double-restore.
      let bootWins: BrowserWindow[] = [];
      try {
        const lastSession = readLastSessionForBoot();
        if (lastSession) {
          restoreWorkspace(lastSession as any);
          bootWins = BrowserWindow.getAllWindows();
          clearLegacySavedLayoutState(cfgPath);
          console.log(`[workspace] restored last-session (${bootWins.length} window(s))`);
        }
      } catch (err) {
        console.error('[workspace] last-session restore failed, opening fresh:', err);
        bootWins = [];
      }
      if (bootWins.length === 0) {
        // Create the terminal window (starts hidden in production)
        bootWins = [createWindow()];
      }

      // Show each window when its content loads. (The once-per-version update
      // splash was removed — it added a confusing extra window to first-boot
      // and nobody missed it.)
      for (const bootWin of bootWins) {
        bootWin.webContents.once('did-finish-load', () => {
          if (!bootWin.isDestroyed() && !bootWin.isVisible()) bootWin.show();
        });
      }
      // Failsafe in case did-finish-load doesn't fire.
      setTimeout(() => {
        for (const bootWin of bootWins) {
          if (!bootWin.isDestroyed() && !bootWin.isVisible()) bootWin.show();
        }
      }, 2000);

      // renderer can request a new window via IPC
      ipcMain.on('new-window', () => createWindow());

      // mac only. when the dock icon is clicked
      // and we don't have any active windows open,
      // we open one
      app.on('activate', () => {
        const win = (app as any).getLastFocusedWindow?.();
        if (win) {
          win.show();

          win.focus();
        } else {
          createWindow();
        }
      });

      app.on('window-all-closed', () => {
        // Keep tray, sidecar, and bridge alive — user can open new windows from tray
        // Only quit on explicit Quit from tray menu or app.quit()
        if (process.platform === 'darwin') {
          // macOS: standard behavior, app stays in dock
        }
      });

      let quitSaveInFlight = false;
      app.on('before-quit', (e) => {
        // Already confirmed / mid-teardown — let it proceed.
        if ((app as {isQuitting?: boolean}).isQuitting) {
          return;
        }
        // A save is already running for an earlier quit gesture — hold this
        // one; the pending save's finally() will quit for real.
        if (quitSaveInFlight) {
          e.preventDefault();
          return;
        }
        // #148: don't silently kill panes running a foreground command on quit
        // (tray → Quit, ⌘Q, menu Quit all land here). Aggregate active panes
        // across every window and confirm before tearing everything down.
        const running: string[] = [];
        for (const w of BrowserWindow.getAllWindows()) {
          const getActive = (w as any).getActiveShellSessions as undefined | (() => Array<{name: string}>);
          if (typeof getActive === 'function') {
            try {
              running.push(...getActive().map((a) => a.name));
            } catch {
              /* window tearing down — ignore */
            }
          }
        }
        // Mark quitting BEFORE windows receive 'close' so their close handler
        // stops preventing close, kill helpers, and force-close windows so the
        // process actually exits (the "still running" bug otherwise).
        const teardown = () => {
          (app as {isQuitting?: boolean}).isQuitting = true;
          destroyTray();
          stopBridge();
          killSidecar();
          for (const w of BrowserWindow.getAllWindows()) {
            try {
              w.destroy();
            } catch {
              /* already gone */
            }
          }
        };
        if (running.length === 0) {
          // Save the whole session BEFORE teardown destroys windows — quit
          // used to save nothing at all (this early-return path predates the
          // workspace pipeline). Bounded: a wedged sidecar can't hold the quit.
          e.preventDefault();
          quitSaveInFlight = true;
          void saveLastSession('quit').finally(() => {
            teardown();
            app.quit();
          });
          return;
        }
        // Busy → confirm via the focused window's in-app modal (the native-dialog
        // fallback lives inside confirmCloseModal). Hold the quit until answered.
        e.preventDefault();
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        const confirmFn = (win as any)?.confirmCloseModal as
          | undefined
          | ((p: {scope: string; names: string[]}) => Promise<boolean>);
        if (!win || typeof confirmFn !== 'function') {
          teardown();
          app.quit();
          return;
        }
        void confirmFn({scope: 'quit', names: running}).then((ok) => {
          if (ok) {
            quitSaveInFlight = true;
            void saveLastSession('quit').finally(() => {
              teardown();
              app.quit();
            });
          }
          // else: user cancelled — stay open (isQuitting stays false).
        });
      });

      const makeMenu = () => {
        const menu = plugins.decorateMenu(AppMenu.createMenu(createWindow, plugins.getLoadedPluginVersions));

        // If we're on Mac make a Dock Menu
        if (process.platform === 'darwin') {
          const dockMenu = Menu.buildFromTemplate([
            {
              label: 'New Window',
              click() {
                createWindow();
              }
            }
          ]);
          app.dock?.setMenu(dockMenu);
        }

        Menu.setApplicationMenu(AppMenu.buildMenu(menu));
      };

      plugins.onApp(app);
      makeMenu();
      plugins.subscribe(plugins.onApp.bind(undefined, app));
      config.subscribe(makeMenu);
      if (!isDev) {
        // check if should be set/removed as default ssh protocol client
        if (config.getConfig().defaultSSHApp && !app.isDefaultProtocolClient('ssh')) {
          isDev && console.log('Setting Hyperia as default client for ssh:// protocol');
          app.setAsDefaultProtocolClient('ssh');
        } else if (!config.getConfig().defaultSSHApp && app.isDefaultProtocolClient('ssh')) {
          isDev && console.log('Removing Hyperia from default client for ssh:// protocol');
          app.removeAsDefaultProtocolClient('ssh');
        }
        void installCLI(false);
      }
    })
    .catch((err) => {
      console.error('Error while loading devtools extensions', err);
    });
});

/**
 * Get last focused BrowserWindow or create new if none and callback
 * @param callback Function to call with the BrowserWindow
 */
function GetWindow(callback: (win: BrowserWindow) => void) {
  const lastWindow = app.getLastFocusedWindow();
  if (lastWindow) {
    callback(lastWindow);
  } else if (!lastWindow && {}.hasOwnProperty.call(app, 'createWindow')) {
    app.createWindow(callback);
  } else {
    // If createWindow doesn't exist yet ('ready' event was not fired),
    // sets his callback to an app.windowCallback property.
    app.windowCallback = callback;
  }
}

app.on('open-file', (_event, path) => {
  GetWindow((win: BrowserWindow) => {
    win.rpc.emit('open file', {path});
  });
});

app.on('open-url', (_event, sshUrl) => {
  GetWindow((win: BrowserWindow) => {
    win.rpc.emit('open ssh', parseUrl(sshUrl));
  });
});
