import {app, Notification, Tray, Menu, nativeImage} from 'electron';

import isDev from 'electron-is-dev';

import {icon} from './config/paths';

let tray: Tray | null = null;
const logRing: string[] = []; // Last N notifications
const MAX_LOG_RING = 50;

export function initTray() {
  if (tray) return;
  try {
    const trayIcon = nativeImage.createFromPath(icon).resize({width: 16, height: 16});
    tray = new Tray(trayIcon);
    tray.setToolTip('Hyperia');
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

function updateTrayMenu() {
  if (!tray) return;
  const recent = logRing.slice(-10).reverse();
  const menuItems: Electron.MenuItemConstructorOptions[] = [
    {label: 'Hyperia', enabled: false},
    {type: 'separator'},
    ...recent.map(
      (line): Electron.MenuItemConstructorOptions => ({
        label: line.length > 80 ? line.slice(0, 77) + '...' : line,
        enabled: false
      })
    )
  ];
  if (recent.length === 0) {
    menuItems.push({label: 'No recent events', enabled: false});
  }
  menuItems.push(
    {type: 'separator'},
    {
      label: 'Clear Log',
      click: () => {
        logRing.length = 0;
        updateTrayMenu();
      }
    },
    {type: 'separator'},
    {
      label: 'Show Window',
      click: () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const win = (app as any).getLastFocusedWindow?.();
        if (win) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          win.show();
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          win.focus();
        }
      }
    },
    {label: 'Quit', click: () => app.quit()}
  );
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
  new Notification({title, body, ...(process.platform === 'linux' && {icon})}).show();
};
