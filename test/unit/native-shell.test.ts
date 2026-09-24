import test from 'ava';

import {isPlainShell, pickNativeShell, profileFitsPlatform} from '../../lib/utils/native-shell';

const win = [
  {
    name: 'Claude',
    kind: 'shell',
    config: {shell: String.raw`C:\Program Files\PowerShell\7\pwsh.exe`, shellArgs: ['-NoExit', '-Command', 'claude']}
  },
  {
    name: 'PowerShell 5.1.26100',
    config: {shell: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, shellArgs: []}
  },
  {name: 'CMD', config: {shell: String.raw`C:\Windows\System32\cmd.exe`, shellArgs: []}},
  {name: 'PowerShell 7.4.1', config: {shell: String.raw`C:\Program Files (x86)\PowerShell\7\pwsh.exe`, shellArgs: []}},
  {
    name: 'PowerShell 7.5.5',
    config: {shell: String.raw`C:\Users\k\AppData\Local\Microsoft\WindowsApps\pwsh.exe`, shellArgs: []}
  },
  {name: 'Codex', config: {shell: String.raw`C:\Windows\System32\cmd.exe`, shellArgs: ['/c', 'codex']}},
  {name: 'zsh', config: {shell: '/bin/zsh', shellArgs: ['--login']}}
];

test('windows: newest detected pwsh wins; custom/agent shells never do', (t) => {
  t.is(pickNativeShell(win, true)?.name, 'PowerShell 7.5.5');
});

test('windows without pwsh falls back to Windows PowerShell, then cmd', (t) => {
  t.is(
    pickNativeShell(
      win.filter((p) => !/pwsh/.test(p.config.shell)),
      true
    )?.name,
    'PowerShell 5.1.26100'
  );
  t.is(
    pickNativeShell(
      win.filter((p) => !/pwsh|powershell/.test(p.config.shell)),
      true
    )?.name,
    'CMD'
  );
});

const mac = [
  {name: 'PowerShell', config: {shell: String.raw`C:\Program Files\PowerShell\7\pwsh.exe`, shellArgs: []}},
  {name: 'bash', config: {shell: '/bin/bash', shellArgs: ['--login']}},
  {name: 'zsh', config: {shell: '/bin/zsh', shellArgs: ['--login']}},
  {name: 'Claude Code', config: {shell: '/bin/zsh', shellArgs: ['-l', '-c', 'claude']}}
];

test('mac: login shell first, never a synced Windows PowerShell entry', (t) => {
  t.is(pickNativeShell(mac, false, '/bin/bash')?.name, 'bash');
  t.is(pickNativeShell(mac, false, '')?.name, 'zsh');
  t.false(isPlainShell(mac[0], false));
  t.false(profileFitsPlatform(mac[0], false));
  t.false(isPlainShell(mac[3], false));
});
