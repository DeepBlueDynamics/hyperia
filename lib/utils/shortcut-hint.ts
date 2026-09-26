/**
 * Keymap → display text for hints ("Ctrl+Alt+Shift+_"). Pure so ava can test
 * it; hints read the decorated keymap instead of hard-coding key strings.
 */

export type Keymaps = Record<string, string[] | string>;

// Every split direction × {split, clone}; the pane band and menus render these.
export const SPLIT_COMMANDS = {
  split: {
    right: 'pane:splitRight',
    down: 'pane:splitDown',
    left: 'pane:splitLeft',
    up: 'pane:splitUp'
  },
  clone: {
    right: 'pane:cloneRight',
    down: 'pane:cloneDown',
    left: 'pane:cloneLeft',
    up: 'pane:cloneUp'
  }
} as const;

const MOD_LABELS: Record<string, {mac: string; other: string}> = {
  command: {mac: 'Cmd', other: 'Cmd'},
  cmd: {mac: 'Cmd', other: 'Cmd'},
  meta: {mac: 'Cmd', other: 'Meta'},
  ctrl: {mac: 'Ctrl', other: 'Ctrl'},
  control: {mac: 'Ctrl', other: 'Ctrl'},
  alt: {mac: 'Option', other: 'Alt'},
  option: {mac: 'Option', other: 'Alt'},
  shift: {mac: 'Shift', other: 'Shift'},
  plus: {mac: '+', other: '+'}
};

/** "ctrl+alt+shift+_" → "Ctrl+Alt+Shift+_" (mac: "Cmd+Option+Shift+_"). Keeps keymap order. */
export const formatShortcut = (shortcut: string, isMac: boolean): string => {
  if (!shortcut) return '';
  // "++" is a literal plus key (Mousetrap convention).
  const parts = shortcut.replace(/\+{2}/g, '+plus').split('+');
  return parts
    .filter((p) => p !== '')
    .map((p) => {
      const mod = MOD_LABELS[p.toLowerCase()];
      if (mod) return isMac ? mod.mac : mod.other;
      return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join('+');
};

/** First binding of `command` (the one menus use), or undefined when unbound. */
export const firstBinding = (keymaps: Keymaps | undefined, command: string): string | undefined => {
  const v = keymaps?.[command];
  const first = Array.isArray(v) ? v[0] : v;
  return first ? first : undefined;
};

/** Display hint for `command` ("" when unbound). */
export const shortcutHint = (keymaps: Keymaps | undefined, command: string, isMac: boolean): string => {
  const first = firstBinding(keymaps, command);
  return first ? formatShortcut(first, isMac) : '';
};
