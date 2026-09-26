import test from 'ava';

import {isPlainShell, pickNativeShell, profileFitsPlatform, shellRunnableHere} from '../../lib/utils/native-shell';

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

test('linux: shells whose absolute path is missing are hidden (stale /bin/zsh profiles)', (t) => {
  const onUbuntu = (path: string) => path === '/bin/bash';
  const zsh = {name: 'zsh', config: {shell: '/bin/zsh', shellArgs: ['--login']}};
  const claudeMac = {name: 'Claude Code (macOS)', config: {shell: '/bin/zsh', shellArgs: ['-l', '-c', 'claude']}};
  const bash = {name: 'bash', config: {shell: '/bin/bash', shellArgs: ['--login']}};
  const cmd = {name: 'CMD', config: {shell: String.raw`C:\Windows\System32\cmd.exe`, shellArgs: []}};
  t.false(shellRunnableHere(zsh, false, onUbuntu));
  t.false(shellRunnableHere(claudeMac, false, onUbuntu));
  t.false(shellRunnableHere(cmd, false, onUbuntu));
  t.true(shellRunnableHere(bash, false, onUbuntu));
  // Bare commands resolve via PATH; never hidden.
  t.true(shellRunnableHere({name: 'ssh', config: {shell: 'ssh'}}, false, () => false));
});

test('windows: a stale absolute pwsh path is hidden', (t) => {
  const pwsh = {name: 'PowerShell 7', config: {shell: String.raw`C:\Program Files\PowerShell\7\pwsh.exe`}};
  t.false(shellRunnableHere(pwsh, true, () => false));
  t.true(shellRunnableHere(pwsh, true, () => true));
});
