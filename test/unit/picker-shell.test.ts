import test from 'ava';

import {resolvePickerShell} from '../../lib/utils/picker-shell';

const shells = ['PowerShell 7', 'CMD', 'Git Bash', 'Claude'];

test('last-used shell wins over the configured default', (t) => {
  t.is(resolvePickerShell(shells, 'PowerShell 7', 'Claude'), 'PowerShell 7');
});

test('configured default seeds the choice before any shell was used', (t) => {
  t.is(resolvePickerShell(shells, undefined, 'Claude'), 'Claude');
});

test('a stale last-used or default name falls through to the first shell', (t) => {
  t.is(resolvePickerShell(shells, 'Deleted Shell', 'Also Gone'), 'PowerShell 7');
  t.is(resolvePickerShell([], 'PowerShell 7', 'Claude'), undefined);
});
