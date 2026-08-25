import {spawn} from 'child_process';
import {existsSync, readFileSync} from 'fs';
import {dirname, join, resolve} from 'path';

import {app, ipcMain, Notification, Tray, Menu, nativeImage} from 'electron';

import isDev from 'electron-is-dev';

import {icon} from './config/paths';
import {getAppIcon} from './utils/icon';

let tray: Tray | null = null;
const logRing: string[] = []; // Last N notifications
const MAX_LOG_RING = 50;

export function initTray() {
  if (tray) return;
  try {
    let trayIcon: Electron.NativeImage | string;
    if (process.platform === 'win32') {
      const icoPath = join(dirname(icon), 'icon.ico');
      if (existsSync(icoPath)) {
        trayIcon = nativeImage.createFromPath(icoPath);
      } else {
        const iconImage = getAppIcon();
        trayIcon =
          typeof iconImage === 'string'
            ? nativeImage.createFromPath(iconImage).resize({width: 16, height: 16})
            : iconImage.resize({width: 16, height: 16});
      }
    } else {
      const iconImage = getAppIcon();
      trayIcon =
        typeof iconImage === 'string'
          ? nativeImage.createFromPath(iconImage).resize({width: 16, height: 16})
          : iconImage.resize({width: 16, height: 16});
    }
    tray = new Tray(trayIcon);
    tray.setToolTip('Hyperia');

    // Left-click: show/focus window, or open a new one if none exist
    tray.on('click', () => {
      const win = getWindow();
      if (win) {
        win.show();
        win.focus();
      } else {
        (app as any).createWindow?.();
      }
    });

    updateTrayMenu();
  } catch (e) {
    console.warn('[tray] Failed to create tray icon:', e);
  }
}

export function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function reconnectStreamDeck() {
  const isWin = process.platform === 'win32';

  // Kill any existing deck-mcp process
  if (isWin) {
    spawn('taskkill', ['/f', '/im', 'deck-mcp.exe']);
  } else {
    spawn('pkill', ['-f', 'deck-mcp']);
  }

  // Wait a moment and then spawn the daemon
  setTimeout(() => {
    let binaryPath: string | null = null;
    const exeName = isWin ? 'deck-mcp.exe' : 'deck-mcp';

    // Find binary. ~/.hyperia/bin is the STABLE location — the dev-tree paths
    // below only resolve when running from a repo checkout (yarn start), so on
    // an installed build the reconnect silently no-opped ("seems not to work").
    const stablePath = join(app.getPath('home'), '.hyperia', 'bin', exeName);
    const paths = [
      stablePath,
      resolve(app.getAppPath(), 'tools/deck-mcp/target/release', exeName),
      resolve(app.getAppPath(), 'tools/deck-mcp/target/debug', exeName),
      resolve(app.getAppPath(), '../tools/deck-mcp/target/release', exeName),
      resolve(app.getAppPath(), '../tools/deck-mcp/target/debug', exeName),
      resolve(process.cwd(), 'tools/deck-mcp/target/release', exeName),
      resolve(process.cwd(), 'tools/deck-mcp/target/debug', exeName)
    ];

    for (const p of paths) {
      if (existsSync(p)) {
        binaryPath = p;
        break;
      }
    }

    if (!binaryPath) {
      // Fail VISIBLY — a console.warn in the packaged app is invisible, and the
      // human's only symptom was "reconnect seems not to work".
      console.warn('[tray] Stream Deck daemon binary not found');
      new Notification({
        title: 'Stream Deck reconnect failed',
        body: `deck-mcp not found. Put ${exeName} in ${dirname(stablePath)} (or run from a repo checkout).`
      }).show();
      return;
    }

    console.log('[tray] Spawning Stream Deck daemon:', binaryPath);

    // Read token if available, matching README run instructions
    let token = '';
    try {
      const cliJsonPath = join(app.getPath('home'), '.hyperia/cli.json');
      if (existsSync(cliJsonPath)) {
        const cliJson = JSON.parse(readFileSync(cliJsonPath, 'utf8'));
        token = cliJson.token || '';
      }
    } catch (err) {
      console.warn('[tray] Failed to read Hyperia token for Stream Deck:', err);
    }

    let daemonCwd = dirname(binaryPath);
    const potentialRoot = resolve(daemonCwd, '../..');
    if (existsSync(join(potentialRoot, 'src'))) {
      daemonCwd = potentialRoot;
    }

    const child = spawn(binaryPath, [], {
      detached: true,
      stdio: 'ignore',
      cwd: daemonCwd,
      env: {
        ...process.env,
        HYPERIA_AGENT_TOKEN: token,
        HYPERIA_URL: 'http://localhost:9800'
      }
    });
    child.unref();
  }, 1000);
}

function getWindow(): Electron.BrowserWindow | null {
  return (app as any).getLastFocusedWindow?.() || null;
}

function updateTrayMenu() {
  if (!tray) return;
  const recent = logRing.slice(-10).reverse();
  const menuItems: Electron.MenuItemConstructorOptions[] = [
    {label: 'Hyperia', enabled: false},
    {type: 'separator'},
    // Primary actions at top — like Stickys
    {
      label: 'New Terminal',
      click: () => {
        const win = getWindow();
        if (win) {
          win.show();
          win.focus();
        } else {
          (app as any).createWindow?.();
        }
      }
    },
    {
      label: 'New Stickys',
      click: () => {
        ipcMain.emit('new-sticky', {});
      }
    },
    {type: 'separator'},
    {
      label: 'Show Window',
      click: () => {
        const win = getWindow();
        if (win) {
          win.show();
          win.focus();
        }
      }
    },
    {
      label: 'New Window',
      click: () => {
        (app as any).createWindow?.();
      }
    },
    {
      label: 'Reconnect Stream Deck',
      click: () => {
        reconnectStreamDeck();
      }
    },
    {type: 'separator'}
  ];

  // Recent events log
  if (recent.length > 0) {
    for (const line of recent) {
      menuItems.push({
        label: line.length > 80 ? line.slice(0, 77) + '...' : line,
        enabled: false
      });
    }
    menuItems.push({
      label: 'Clear Log',
      click: () => {
        logRing.length = 0;
        updateTrayMenu();
      }
    });
  }

  menuItems.push({type: 'separator'}, {label: 'Quit', click: () => app.quit()});
  tray.setContextMenu(Menu.buildFromTemplate(menuItems));
}

export default function notify(title: string, body = '', details: {error?: any} = {}) {
  const line = `${title}${body ? ': ' + body : ''}`;
  isDev && console.log(`[Notification] ${line}`);
  if (details.error) {
    isDev && console.error(details.error);
  }

  // Add to log ring and update tray
  logRing.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (logRing.length > MAX_LOG_RING) logRing.shift();
  updateTrayMenu();

  // Update tray tooltip with latest
  if (tray) {
    tray.setToolTip(`Hyperia — ${line}`);
  }

  if (app.isReady()) {
    _createNotification(title, body);
  } else {
    app.on('ready', () => {
      _createNotification(title, body);
    });
  }
}

const _createNotification = (title: string, body: string) => {
  new Notification({
    title,
    body,
    ...(process.platform === 'linux' && {icon})
  }).show();
};
