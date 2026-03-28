import type {BaseWindow, BrowserWindow, MenuItemConstructorOptions} from 'electron';

const toolsMenu = (
  commands: Record<string, string>,
  _execCommand: (command: string, focusedWindow?: BrowserWindow) => void
): MenuItemConstructorOptions => {
  const execCommand = (cmd: string, win?: BaseWindow) => _execCommand(cmd, win as BrowserWindow);

  return {
    label: 'Tools',
    submenu: [
      {
        label: 'Update plugins',
        accelerator: commands['plugins:update'],
        click() {
          execCommand('plugins:update');
        }
      },
      {
        label: 'Install Hyperia CLI command in PATH',
        click() {
          execCommand('cli:install');
        }
      },
      ...(process.platform === 'win32'
        ? <MenuItemConstructorOptions[]>[
            {
              type: 'separator'
            },
            {
              label: 'Add Hyperia to system context menu',
              click() {
                execCommand('systemContextMenu:add');
              }
            },
            {
              label: 'Remove Hyperia from system context menu',
              click() {
                execCommand('systemContextMenu:remove');
              }
            }
          ]
        : [])
    ]
  };
};

export default toolsMenu;
