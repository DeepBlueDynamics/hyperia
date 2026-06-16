import {app, ipcMain, Notification, Tray, Menu, nativeImage} from 'electron';
import {existsSync} from 'fs';
import {dirname, join} from 'path';

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
        trayIcon = typeof iconImage === 'string'
          ? nativeImage.createFromPath(iconImage).resize({width: 16, height: 16})
          : iconImage.resize({width: 16, height: 16});
      }
    } else {
      const iconImage = getAppIcon();
      trayIcon = typeof iconImage === 'string'
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
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

function getWindow(): Electron.BrowserWindow | null {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          (app as any).createWindow?.();
        }
      }
    },
    {
      label: 'New Note',
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        (app as any).createWindow?.();
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
