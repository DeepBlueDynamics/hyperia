import {ipcMain, BrowserWindow} from 'electron';
import type {MenuItemConstructorOptions} from 'electron';

import {execCommand} from '../commands';
import {getDecoratedKeymaps} from '../plugins';

const separator: MenuItemConstructorOptions = {type: 'separator'};

const getCommandKeys = (keymaps: Record<string, string[]>): Record<string, string> =>
  Object.keys(keymaps).reduce((commandKeys: Record<string, string>, command) => {
    return Object.assign(commandKeys, {
      [command]: keymaps[command][0]
    });
  }, {});

// Capture the focused window at click time so execCommand has a target.
const cmd =
  (command: string): MenuItemConstructorOptions['click'] =>
  () =>
    execCommand(command, BrowserWindow.getFocusedWindow() ?? undefined);

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
  menu.push({label: 'Split Down', accelerator: commandKeys['pane:splitDown'], click: cmd('pane:splitDown')});
  menu.push({label: 'Split Right', accelerator: commandKeys['pane:splitRight'], click: cmd('pane:splitRight')});
  menu.push({label: 'Close Pane', accelerator: commandKeys['pane:close'], click: cmd('pane:close')});
  menu.push({label: 'Open as Web Pane…', click: cmd('pane:openWebPane')});

  menu.push(separator);
  menu.push({label: 'New Tab', accelerator: commandKeys['tab:new'], click: cmd('tab:new')});
  menu.push({label: 'New Window', click: () => createWindow()});

  menu.push(separator);
  menu.push({label: 'New Note', click: () => ipcMain.emit('new-sticky', {})});
  menu.push({label: 'Ask Hyperia', click: () => ipcMain.emit('open-ghost')});

  menu.push(separator);
  menu.push({label: 'Clear Buffer', accelerator: commandKeys['editor:clearBuffer'], click: cmd('editor:clearBuffer')});
  menu.push({label: 'Search', accelerator: commandKeys['editor:search'], click: cmd('editor:search')});

  if (process.platform !== 'darwin') {
    menu.push(separator);
    menu.push({label: 'Preferences', click: cmd('window:preferences')});
  }

  return menu;
};

export default contextMenuTemplate;
