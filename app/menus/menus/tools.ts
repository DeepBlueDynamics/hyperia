import {spawn} from 'child_process';
import type {ChildProcess} from 'child_process';
import {resolve} from 'path';

import type {BaseWindow, BrowserWindow, MenuItemConstructorOptions} from 'electron';

let auracleProcess: ChildProcess | null = null;

function findAuracleBinary(): string | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  const candidates = [
    resolve(__dirname, '../../djimic/target/release/auracle.exe'),
    resolve(__dirname, '../../djimic/target/debug/auracle.exe'),
    resolve(__dirname, '../../../djimic/target/release/auracle.exe'),
    resolve(__dirname, '../../../djimic/target/debug/auracle.exe'),
    resolve(__dirname, '../../djimic/target/release/auracle'),
    resolve(__dirname, '../../djimic/target/debug/auracle'),
    resolve(__dirname, '../../../djimic/target/release/auracle'),
    resolve(__dirname, '../../../djimic/target/debug/auracle')
  ];
  for (const c of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      fs.accessSync(c);
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

function startAuracle(sidecarPort: number) {
  if (auracleProcess) {
    console.log('[auracle] Already running');
    return;
  }

  const bin = findAuracleBinary();
  if (!bin) {
    console.warn('[auracle] Binary not found. Build it: cd djimic && cargo build');
    return;
  }

  const forwardUrl = `http://127.0.0.1:${sidecarPort}/api/type/0`;
  console.log(`[auracle] Starting: ${bin} serve --auto-listen --forward-url ${forwardUrl}`);

  auracleProcess = spawn(bin, ['serve', '--auto-listen', '--forward-url', forwardUrl], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  auracleProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[auracle] ${data.toString().trim()}`);
  });
  auracleProcess.stderr?.on('data', (data: Buffer) => {
    console.log(`[auracle] ${data.toString().trim()}`);
  });
  auracleProcess.on('exit', (code: number | null) => {
    console.log(`[auracle] Exited with code ${code}`);
    auracleProcess = null;
  });
}

function stopAuracle() {
  if (auracleProcess) {
    console.log('[auracle] Stopping');
    auracleProcess.kill();
    auracleProcess = null;
  }
}

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
      {
        type: 'separator'
      },
      ...(process.platform === 'win32'
        ? <MenuItemConstructorOptions[]>[
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
            },
            {
              type: 'separator'
            }
          ]
        : []),
      {
        type: 'separator'
      },
      {
        label: 'Start Auracle Dictation',
        click() {
          startAuracle(9800);
        }
      },
      {
        label: 'Stop Auracle Dictation',
        click() {
          stopAuracle();
        }
      }
    ]
  };
};

export default toolsMenu;
