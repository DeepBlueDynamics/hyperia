import {ipcMain, clipboard} from 'electron';
import type {BrowserWindow, MenuItemConstructorOptions} from 'electron';

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
  selection: string,
  win: BrowserWindow
): MenuItemConstructorOptions[] => {
  // Capture the window NOW (before the menu is shown), not at click time.
  // getFocusedWindow() returns null once the context menu is visible.
  const cmd =
    (command: string): MenuItemConstructorOptions['click'] =>
    () =>
      execCommand(command, win);

  const commandKeys = getCommandKeys(getDecoratedKeymaps());

  const menu: MenuItemConstructorOptions[] = [];

  if (selection) {
    menu.push({
      label: 'Copy',
      accelerator: commandKeys['editor:copy'],
      click: () => {
        clipboard.writeText(selection);
      }
    });
  }
  menu.push({label: 'Paste', role: 'paste', accelerator: commandKeys['editor:paste']});

  menu.push(separator);
  menu.push({label: 'Split Right', accelerator: commandKeys['pane:splitRight'], click: cmd('pane:splitRight')});
  menu.push({label: 'Split Down', accelerator: commandKeys['pane:splitDown'], click: cmd('pane:splitDown')});
  menu.push({label: 'Clone Right', accelerator: commandKeys['pane:cloneRight'], click: cmd('pane:cloneRight')});
  menu.push({label: 'Clone Down', accelerator: commandKeys['pane:cloneDown'], click: cmd('pane:cloneDown')});
  menu.push({label: 'Close Pane', accelerator: commandKeys['pane:close'], click: cmd('pane:close')});

  menu.push(separator);
  menu.push({label: 'New Tab', accelerator: commandKeys['tab:new'], click: cmd('tab:new')});
  menu.push({label: 'New Window', click: () => createWindow()});

  menu.push(separator);
  menu.push({label: 'New Stickys', click: () => ipcMain.emit('new-sticky', {})});
  menu.push({label: 'Search Stickys', click: () => ipcMain.emit('search-stickies')});

  menu.push(separator);
  menu.push({label: 'Clear Buffer', accelerator: commandKeys['editor:clearBuffer'], click: cmd('editor:clearBuffer')});
  menu.push({label: 'Search', accelerator: commandKeys['editor:search'], click: cmd('editor:search')});

  return menu;
};

export default contextMenuTemplate;
