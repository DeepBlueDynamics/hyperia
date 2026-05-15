import {readFileSync} from 'fs';
import {homedir} from 'os';
import {join} from 'path';

import {ipcMain} from 'electron';
import type {BrowserWindow, MenuItemConstructorOptions} from 'electron';

import {execCommand} from '../commands';
import {getDecoratedKeymaps} from '../plugins';

const separator: MenuItemConstructorOptions = {type: 'separator'};

// Check whether the user has a usable agent setup. Used to hide the
// "Ask Hyperia" menu item when there's no AI connection — pointing at it
// from a context menu would just dead-end. Read the config fresh each time
// (cheap, ~kb file) so the menu reflects the user's current state.
function hasAgentConfigured(): boolean {
  try {
    const raw = readFileSync(join(homedir(), '.hyperia', 'hyperia.json'), 'utf8');
    const cfg = JSON.parse(raw) as {config?: any};
    const c = cfg.config ?? {};
    const newProvider: string | undefined = c.agent?.provider;
    if (newProvider === 'ollama') return true;
    if (newProvider && c.providers?.[newProvider]?.token) return true;
    if (c.agentToken) return true;
    if (typeof c.agentModel === 'string' && (c.agentModel as string).startsWith('ollama:')) return true;
    return false;
  } catch {
    return false;
  }
}

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
    menu.push({label: 'Copy', role: 'copy'});
  }
  menu.push({label: 'Paste', role: 'paste'});

  menu.push(separator);
  menu.push({label: 'Split Down', accelerator: commandKeys['pane:splitDown'], click: cmd('pane:splitDown')});
  menu.push({label: 'Split Right', accelerator: commandKeys['pane:splitRight'], click: cmd('pane:splitRight')});
  menu.push({label: 'Close Pane', accelerator: commandKeys['pane:close'], click: cmd('pane:close')});
  menu.push({label: 'New Web Pane…', click: cmd('pane:openWebPane')});

  menu.push(separator);
  menu.push({label: 'New Tab', accelerator: commandKeys['tab:new'], click: cmd('tab:new')});
  menu.push({label: 'New Window', click: () => createWindow()});

  menu.push(separator);
  menu.push({label: 'New Note', click: () => ipcMain.emit('new-sticky', {})});
  if (hasAgentConfigured()) {
    menu.push({label: 'Ask Hyperia', click: () => ipcMain.emit('open-ghost')});
  }

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
