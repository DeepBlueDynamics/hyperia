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
import {installCLI} from './utils/cli-install';
import * as windowUtils from './utils/window-utils';

const windowSet = new Set<BrowserWindow>([]);

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

async function spawnSidecar() {
  const sidecarPath = findSidecarBinary();
  if (!sidecarPath) return;

  isDev && console.log(`[sidecar] __dirname = ${__dirname}`);

  // Kill any existing sidecar before spawning
  await killExistingSidecars();

  isDev && console.log(`[sidecar] Spawning: ${sidecarPath} --port ${SIDECAR_PORT}`);
  sidecarProcess = spawn(sidecarPath, ['--port', String(SIDECAR_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
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

function _showSplash(
  winBounds: {x: number; y: number; width: number; height: number},
  mainWin: BrowserWindow
): Promise<void> {
  return new Promise((resolve_) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {icon: appIcon} = require('./config/paths');
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
      icon: appIcon,
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
app.on('ready', () => {
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

        const [width, height] = options.size ? options.size : cfg.windowSize || winSet.size;

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

        const hwin = newWindow({width, height, x: startX, y: startY}, cfg, fn, profileName);
        windowSet.add(hwin);
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

      // Show splash immediately (don't wait for window to show)
      void _showSplash(firstWin.getBounds(), firstWin);

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
          app.dock.setMenu(dockMenu);
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
