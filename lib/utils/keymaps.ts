import React from 'react';

import {subscribe} from './config';
import {ipcRenderer} from './ipc';
import {firstBinding, shortcutHint} from './shortcut-hint';
import type {Keymaps} from './shortcut-hint';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);

// One async fetch shared by every hint; refreshed when config/plugins change (user keymaps).
let cached: Keymaps | undefined;
let inflight: Promise<Keymaps> | undefined;
const listeners = new Set<() => void>();

const load = (): Promise<Keymaps> => {
  if (!inflight) {
    inflight = ipcRenderer
      .invoke('getDecoratedKeymaps')
      .then((k: Keymaps) => {
        cached = k || {};
        listeners.forEach((fn) => fn());
        return cached;
      })
      .catch(() => {
        inflight = undefined;
        return cached || {};
      });
  }
  return inflight;
};

let subscribed = false;
const ensureSubscribed = () => {
  if (subscribed) return;
  subscribed = true;
  try {
    subscribe(() => {
      inflight = undefined;
      void load();
    });
  } catch {
    subscribed = false;
  }
};

/** Keymaps if already loaded (kicks off a load otherwise). */
export const getCachedKeymaps = (): Keymaps | undefined => {
  ensureSubscribed();
  if (!cached) void load();
  return cached;
};

/** Electron accelerator for a command: its first keymap binding, as the app menu uses. */
export const acceleratorFor = (command: string): string | undefined => firstBinding(getCachedKeymaps(), command);

/** Hook: display hint for each command, re-rendered once the keymap arrives. */
export const useShortcutHints = <T extends string>(commands: readonly T[]): Record<T, string> => {
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);
  const keymaps = getCachedKeymaps();
  const out = {} as Record<T, string>;
  for (const c of commands) out[c] = shortcutHint(keymaps, c, isMac);
  return out;
};
