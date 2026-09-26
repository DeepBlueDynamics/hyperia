import test from 'ava';

import darwin from '../../app/keymaps/darwin.json';
import linux from '../../app/keymaps/linux.json';
import win32 from '../../app/keymaps/win32.json';
import {formatShortcut, firstBinding, shortcutHint, SPLIT_COMMANDS} from '../../lib/utils/shortcut-hint';

const PLATFORMS: Record<string, Record<string, string | string[]>> = {win32, darwin, linux};
const ALL = [...Object.values(SPLIT_COMMANDS.split), ...Object.values(SPLIT_COMMANDS.clone)];

test('formatShortcut keeps keymap order and capitalizes', (t) => {
  t.is(formatShortcut('ctrl+alt+shift+_', false), 'Ctrl+Alt+Shift+_');
  t.is(formatShortcut('ctrl+shift+d', false), 'Ctrl+Shift+D');
  t.is(formatShortcut('ctrl+shift+"', false), 'Ctrl+Shift+"');
  t.is(formatShortcut('ctrl+shift+pageup', false), 'Ctrl+Shift+Pageup');
});

test('formatShortcut uses mac modifier names', (t) => {
  t.is(formatShortcut('command+alt+shift+<', true), 'Cmd+Option+Shift+<');
  t.is(formatShortcut('command+shift+_', true), 'Cmd+Shift+_');
});

test('formatShortcut handles the literal plus key and empty input', (t) => {
  t.is(formatShortcut('ctrl++', false), 'Ctrl++');
  t.is(formatShortcut('', false), '');
});

test('firstBinding / shortcutHint read the first binding, empty when unbound', (t) => {
  const km = {'pane:splitRight': ['ctrl+shift+d', 'ctrl+shift+|'], 'pane:splitDown': 'ctrl+shift+_'};
  t.is(firstBinding(km, 'pane:splitRight'), 'ctrl+shift+d');
  t.is(shortcutHint(km, 'pane:splitDown', false), 'Ctrl+Shift+_');
  t.is(shortcutHint(km, 'pane:splitUp', false), '');
  t.is(shortcutHint(undefined, 'pane:splitUp', false), '');
});

test('every direction x {split, clone} is bound on every platform', (t) => {
  for (const [platform, km] of Object.entries(PLATFORMS)) {
    for (const cmd of ALL) {
      t.truthy(firstBinding(km, cmd), `${platform} missing ${cmd}`);
    }
  }
});

test('no key is bound to two commands on any platform', (t) => {
  for (const [platform, km] of Object.entries(PLATFORMS)) {
    const seen = new Map<string, string>();
    for (const [cmd, v] of Object.entries(km)) {
      for (const key of ([] as string[]).concat(v)) {
        if (!key) continue;
        const k = key.toLowerCase();
        t.false(seen.has(k), `${platform}: ${key} bound to ${seen.get(k)} and ${cmd}`);
        seen.set(k, cmd);
      }
    }
  }
});

test('clone = split + alt, on every platform and direction', (t) => {
  for (const [platform, km] of Object.entries(PLATFORMS)) {
    for (const dir of ['right', 'down', 'left', 'up'] as const) {
      const split = firstBinding(km, SPLIT_COMMANDS.split[dir])!;
      const clone = firstBinding(km, SPLIT_COMMANDS.clone[dir])!;
      t.is(clone.replace('+alt', ''), split, `${platform} ${dir}`);
    }
  }
});
