import type {BaseWindow, BrowserWindow, MenuItemConstructorOptions} from 'electron';

const shellMenu = (
  commandKeys: Record<string, string>,
  _execCommand: (command: string, focusedWindow?: BrowserWindow) => void,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _profiles: string[]
): MenuItemConstructorOptions => {
  const execCommand = (cmd: string, win?: BaseWindow) => _execCommand(cmd, win as BrowserWindow);
  const isMac = process.platform === 'darwin';

  return {
    label: isMac ? 'Shell' : 'File',
    submenu: [
      {
        label: 'New Tab',
        accelerator: commandKeys['tab:new'],
        click(item, focusedWindow) {
          execCommand('tab:new', focusedWindow);
        }
      },
      {
        label: 'New Window',
        accelerator: commandKeys['window:new'],
        click(item, focusedWindow) {
          execCommand('window:new', focusedWindow);
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Split Down',
        accelerator: commandKeys['pane:splitDown'],
        click(item, focusedWindow) {
          execCommand('pane:splitDown', focusedWindow);
        }
      },
      {
        label: 'Split Right',
        accelerator: commandKeys['pane:splitRight'],
        click(item, focusedWindow) {
          execCommand('pane:splitRight', focusedWindow);
        }
      },
      {
        label: 'Clone Down',
        accelerator: commandKeys['pane:cloneDown'],
        click(item, focusedWindow) {
          execCommand('pane:cloneDown', focusedWindow);
        }
      },
      {
        label: 'Clone Right',
        accelerator: commandKeys['pane:cloneRight'],
        click(item, focusedWindow) {
          execCommand('pane:cloneRight', focusedWindow);
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Close',
        accelerator: commandKeys['pane:close'],
        click(item, focusedWindow) {
          execCommand('pane:close', focusedWindow);
        }
      },
      {
        label: isMac ? 'Close Window' : 'Quit',
        role: 'close',
        accelerator: commandKeys['window:close']
      }
    ]
  };
};

export default shellMenu;
