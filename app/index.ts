// eslint-disable-next-line import/order
import {cfgPath} from './config/paths';
import {SYSTEM_TOKEN} from './system-token';

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
app.name = 'Hyperia-Terminal';
app.setName('Hyperia-Terminal');

// Pin Electron's userData directory to a STABLE path so it is NOT derived from
// the display name. Electron defaults userData to %APPDATA%/<app.name>, so every
// productName change (Hyperia → Hyperia2 → Hyperia-Terminal) moved the data dir
// and orphaned localStorage — web-pane URL history, dir history, the private-mode
// toggle, etc. (issue #127). Freezing the dir here lets the display name change
// freely without ever stranding history. "Hyperia-Terminal" is chosen because
// current installs already store there, so this is a no-op move for them.
try {
  app.setPath('userData', resolve(app.getPath('appData'), 'Hyperia-Terminal'));
} catch (e) {
  console.warn('[userData] failed to pin stable path:', e);
}

if (process.platform === 'win32') {
  try {
    // Versioned AUMID — BUMP THIS SUFFIX EVERY RELEASE (…-v0128, -v0129, …).
    // Windows keys the taskbar/shortcut icon cache off the AUMID; a fresh AUMID
    // each release sidesteps the poisoned per-AUMID icon cache so the icon always
    // reads clean from the exe. NOTE: this is intentionally DIFFERENT from the
    // electron-builder appId (com.deepbluedynamics.hyperia), which stays stable so
    // auto-update / install-in-place keeps working. Trade-off: a taskbar pin won't
    // follow across versions (AUMID changes), so a re-pin may be needed per update.
    app.setAppUserModelId('com.deepbluedynamics.hyperia-v01215');
  } catch {
    /* non-fatal */
  }
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

import {startBridge, stopBridge} from './bridge';
import {initHyperia} from './ghost';
import * as AppMenu from './menus/menu';
import {initTray, destroyTray} from './notify';
import * as plugins from './plugins';
import {initSettings} from './settings';
import {initSticky} from './sticky';
import {newWindow} from './ui/window';
import {getAppIcon} from './utils/icon';
import {installCLI} from './utils/cli-install';
import * as windowUtils from './utils/window-utils';
import {restoreFor} from './window-state';

const windowSet = new Set<BrowserWindow>([]);

// Splash screen — shown ONCE per installed version. The first launch after an
// install/update casts the splash; a marker in the config dir then suppresses it
// on every subsequent launch (on any platform). Returns true exactly once per
// version, and only if the marker was persisted (so a write failure can't make
// the splash reappear every launch).
function shouldShowSplashOnce(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {cfgDir} = require('./config/paths');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const stateFile = path.join(cfgDir, 'splash-state.json');
    const version = app.getVersion();
    try {
      const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (stored && stored.version === version) return false; // already shown for this install
    } catch {
      /* no state file yet — first launch for this install */
    }
    // Mark BEFORE showing so a crash mid-splash can't re-trigger it forever.
    fs.writeFileSync(stateFile, JSON.stringify({version}), 'utf8');
    return true;
  } catch {
    return false; // can't persist the marker → don't risk showing it every launch
  }
}

function _showSplash(
  winBounds: {x: number; y: number; width: number; height: number},
  mainWin: BrowserWindow
): Promise<void> {
  return new Promise((resolve_) => {
    const splash = new BrowserWindow({
      x: winBounds.x,
      y: winBounds.y,
      width: winBounds.width,
      height: winBounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      icon: getAppIcon(),
      title: 'Hyperia',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: resolve(__dirname, 'splash-preload.js')
      }
    });

    void splash.loadFile(resolve(isDev ? __dirname : app.getAppPath(), 'splash.html'));

    // Signal splash as soon as main window content loads
    mainWin.webContents.once('did-finish-load', () => {
      if (!splash.isDestroyed()) {
        splash.webContents.send('app-ready');
      }
    });

    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      if (!splash.isDestroyed()) {
        let opacity = 1;
        const fadeInterval = setInterval(() => {
          opacity -= 0.15;
          if (opacity <= 0 || splash.isDestroyed()) {
            clearInterval(fadeInterval);
            if (!splash.isDestroyed()) {
              splash.destroy();
            }
            // Show main window after splash is gone
            if (!mainWin.isDestroyed() && !mainWin.isVisible()) {
              mainWin.show();
            }
          } else {
            try {
              splash.setOpacity(opacity);
            } catch {
              /* already gone */
            }
          }
        }, 30);
      }
      resolve_();
    };

    ipcMain.once('splash-done', done);
    // Failsafe: close after 8 seconds max
    setTimeout(done, 8000);
  });
}

// --- Sidecar process (Rust agent engine, MCP) ---
let sidecarProcess: ChildProcess | null = null;
const SIDECAR_PORT = 9800;

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
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call
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

// Single instance lock — prevent duplicate tray icons and sidecar spawns
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
app.on('second-instance', () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const win = (app as any).getLastFocusedWindow?.();
  if (win) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    if (win.isMinimized()) win.restore();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    win.focus();
  } else {
    // All windows were closed — open a new one
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    (app as any).createWindow?.();
  }
});

// eslint-disable-next-line @typescript-eslint/no-misused-promises
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

  return installDevExtensions(isDev)
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
          const restore = restoreFor({width, height, x: startX, y: startY});
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
          hwin.clean();
          windowSet.delete(hwin);
        });

        return hwin;
      }

      // Create the terminal window (starts hidden in production)
      const firstWin = createWindow();

      // Splash only on the first launch after an install/update (once per
      // version, any platform). _showSplash fades out and reveals the main
      // window itself; otherwise just show the window when its content loads.
      if (shouldShowSplashOnce()) {
        void _showSplash(firstWin.getBounds(), firstWin);
      } else {
        firstWin.webContents.once('did-finish-load', () => {
          if (!firstWin.isDestroyed() && !firstWin.isVisible()) firstWin.show();
        });
        // Failsafe in case did-finish-load doesn't fire.
        setTimeout(() => {
          if (!firstWin.isDestroyed() && !firstWin.isVisible()) firstWin.show();
        }, 2000);
      }

      // expose to plugins
      app.createWindow = createWindow;

      // renderer can request a new window via IPC
      ipcMain.on('new-window', () => createWindow());

      // mac only. when the dock icon is clicked
      // and we don't have any active windows open,
      // we open one
      app.on('activate', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const win = (app as any).getLastFocusedWindow?.();
        if (win) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          win.show();
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
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

      app.on('before-quit', () => {
        destroyTray();
        stopBridge();
        killSidecar();
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
