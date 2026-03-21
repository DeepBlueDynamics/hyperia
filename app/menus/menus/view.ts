import type {BaseWindow, BrowserWindow, MenuItemConstructorOptions} from 'electron';

import {getProfiles} from '../../config';
import {getDecoratedConfig} from '../../plugins';
import toElectronBackgroundColor from '../../utils/to-electron-background-color';

/** Visual-only profiles have no `shell` in their config */
function getThemeProfiles(): string[] {
  const profiles = getProfiles();
  if (!profiles) return [];
  return profiles.filter((p) => !p.config.shell).map((p) => p.name);
}

function applyTheme(win: BrowserWindow, profileName: string) {
  (win as any).profileName = profileName;
  const cfg = getDecoratedConfig(profileName);
  win.setBackgroundColor(toElectronBackgroundColor(cfg.backgroundColor || '#000'));
  win.webContents.send('config change');
}

const viewMenu = (
  commandKeys: Record<string, string>,
  _execCommand: (command: string, focusedWindow?: BrowserWindow) => void
): MenuItemConstructorOptions => {
  const execCommand = (cmd: string, win?: BaseWindow) => _execCommand(cmd, win as BrowserWindow);

  const themeNames = getThemeProfiles();

  return {
    label: 'View',
    submenu: [
      {
        label: 'Reload',
        accelerator: commandKeys['window:reload'],
        click(item, focusedWindow) {
          execCommand('window:reload', focusedWindow);
        }
      },
      {
        label: 'Full Reload',
        accelerator: commandKeys['window:reloadFull'],
        click(item, focusedWindow) {
          execCommand('window:reloadFull', focusedWindow);
        }
      },
      {
        label: 'Developer Tools',
        accelerator: commandKeys['window:devtools'],
        click: (item, focusedWindow) => {
          execCommand('window:devtools', focusedWindow);
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Reset Zoom Level',
        accelerator: commandKeys['zoom:reset'],
        click(item, focusedWindow) {
          execCommand('zoom:reset', focusedWindow);
        }
      },
      {
        label: 'Zoom In',
        accelerator: commandKeys['zoom:in'],
        click(item, focusedWindow) {
          execCommand('zoom:in', focusedWindow);
        }
      },
      {
        label: 'Zoom Out',
        accelerator: commandKeys['zoom:out'],
        click(item, focusedWindow) {
          execCommand('zoom:out', focusedWindow);
        }
      },
      ...(themeNames.length > 0
        ? [
            {type: 'separator' as const},
            {
              label: 'Theme',
              submenu: themeNames.map((name) => ({
                label: name,
                type: 'radio' as const,
                checked: false,
                click(_item: Electron.MenuItem, focusedWindow?: BaseWindow) {
                  if (focusedWindow && 'webContents' in focusedWindow) {
                    applyTheme(focusedWindow as BrowserWindow, name);
                  }
                }
              }))
            }
          ]
        : [])
    ]
  };
};

export default viewMenu;
