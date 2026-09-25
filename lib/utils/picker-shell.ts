// Which shell a new-pane picker means by "the shell": remembered LAST-USED, then
// the configured defaultProfile, then the first shell. Shared by the picker's
// New Shell pulldown AND the directory navigator's Go in a picker pane, so what
// the pulldown shows is exactly what Go launches (they used to disagree: Go
// launched config.defaultProfile while the pulldown showed the last-used shell).

export const LS_LAST_SHELL = 'hyperia.picker.defaultShell';

export function readLastUsedShell(): string | undefined {
  try {
    return window.localStorage.getItem(LS_LAST_SHELL) || undefined;
  } catch {
    return undefined;
  }
}

/** Tell the main process, so its own fallbacks (getDefaultProfile) agree. */
export function reportLastUsedShell(name: string | undefined): void {
  if (!name) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('electron').ipcRenderer.send('last-used-shell', name);
  } catch {
    /* not in Electron (tests) */
  }
}

/** Pick from `shells` (profile names, in display order): last-used → default → first. */
export function resolvePickerShell(
  shells: string[],
  lastUsed: string | undefined,
  defaultProfile: string | undefined
): string | undefined {
  if (lastUsed && shells.includes(lastUsed)) return lastUsed;
  if (defaultProfile && shells.includes(defaultProfile)) return defaultProfile;
  return shells[0];
}
