import {ipcMain} from 'electron';
import type {MenuItemConstructorOptions, BrowserWindow} from 'electron';

import {execCommand} from '../commands';
import {getDecoratedKeymaps} from '../plugins';

const separator: MenuItemConstructorOptions = {type: 'separator'};

const getCommandKeys = (keymaps: Record<string, string[]>): Record<string, string> =>
  Object.keys(keymaps).reduce((commandKeys: Record<string, string>, command) => {
    return Object.assign(commandKeys, {
      [command]: keymaps[command][0]
    });
  }, {});

const contextMenuTemplate = (
  createWindow: (fn?: (win: BrowserWindow) => void, options?: Record<string, any>) => BrowserWindow,
  selection: string
): MenuItemConstructorOptions[] => {
  const commandKeys = getCommandKeys(getDecoratedKeymaps());

  const menu: MenuItemConstructorOptions[] = [];

  if (selection) {
    menu.push({label: 'Copy', role: 'copy'});
  }
  menu.push({label: 'Paste', role: 'paste'});

  menu.push(separator);
  menu.push({
    label: 'Split Down',
    accelerator: commandKeys['pane:splitDown'],
    click: () => execCommand('pane:splitDown')
  });
  menu.push({
    label: 'Split Right',
    accelerator: commandKeys['pane:splitRight'],
    click: () => execCommand('pane:splitRight')
  });
  menu.push({
    label: 'Close Pane',
    accelerator: commandKeys['pane:close'],
    click: () => execCommand('pane:close')
  });

  menu.push({
    label: 'Open as Web Pane…',
    click: () => execCommand('pane:openWebPane')
  });

  menu.push(separator);
  menu.push({
    label: 'New Tab',
    accelerator: commandKeys['tab:new'],
    click: () => execCommand('tab:new')
  });
  menu.push({
    label: 'New Window',
    click: () => createWindow()
  });

  menu.push(separator);
  menu.push({
    label: 'New Note',
    click: () => ipcMain.emit('new-sticky', {})
  });
  menu.push({
    label: 'Ask Hyperia',
    click: () => ipcMain.emit('open-ghost')
  });

  menu.push(separator);
  menu.push({
    label: 'Clear Buffer',
    accelerator: commandKeys['editor:clearBuffer'],
    click: () => execCommand('editor:clearBuffer')
  });
  menu.push({
    label: 'Search',
    accelerator: commandKeys['editor:search'],
    click: () => execCommand('editor:search')
  });

  if (process.platform !== 'darwin') {
    menu.push(separator);
    menu.push({
      label: 'Preferences',
      click: () => execCommand('window:preferences')
    });
  }

  return menu;
};

export default contextMenuTemplate;
