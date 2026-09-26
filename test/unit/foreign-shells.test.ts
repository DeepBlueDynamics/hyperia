import test from 'ava';

import {dropForeignShells} from '../../app/utils/foreign-shells';

const stale = [
  {name: 'zsh', config: {shell: '/bin/zsh', shellArgs: ['--login']}},
  {name: 'bash', config: {shell: '/bin/bash', shellArgs: ['--login']}},
  {name: 'PowerShell', config: {shell: String.raw`C:\Program Files\PowerShell\7\pwsh.exe`}},
  {name: 'CMD', config: {shell: String.raw`C:\Windows\System32\cmd.exe`}},
  {name: 'Ubuntu (WSL)', config: {shell: String.raw`C:\Windows\System32\wsl.exe`}},
  {name: 'Claude Code (macOS)', config: {shell: '/bin/zsh', shellArgs: ['-l', '-c', 'claude']}},
  {name: 'Claude Code (Windows)', config: {shell: String.raw`C:\Windows\System32\cmd.exe`}},
  {name: 'ssh box', config: {shell: 'ssh'}},
  {name: 'default', config: {}}
];

const ubuntu = (path: string) => path === '/bin/bash';

test('linux: Windows shells and missing /bin/zsh profiles are dropped', (t) => {
  t.deepEqual(
    dropForeignShells(stale, 'linux', ubuntu).map((p) => p.name),
    ['bash', 'ssh box', 'default']
  );
});

test('windows: the list is left alone', (t) => {
  t.is(
    dropForeignShells(stale, 'win32', () => false),
    stale
  );
});
