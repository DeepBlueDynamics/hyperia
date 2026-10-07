// Native web panes paint above ALL renderer DOM, so a DOM overlay that can land
// over the pane area has to pull them off-screen (frozen still) while it's up.
// Each overlay holds its own key; main restores the panes only when the last
// holder lets go (app/web-pane-manager.ts). Transient notices belong on the
// native toast layer instead (lib/toast-layer.ts) — this is for interactive UI.

import {ipcRenderer} from 'electron';
import {useEffect, useRef} from 'react';

let seq = 0;

/** A unique holder key for one overlay instance. */
export function newSuppressHolder(name: string): string {
  return `${name}#${++seq}`;
}

export function suppressWebPanes(holder: string, suppressed: boolean): void {
  try {
    ipcRenderer.send('web-panes:suppress', {suppressed, holder});
  } catch {
    /* ipc not ready */
  }
}

/** Hold web panes off-screen while `active`; released on false or unmount. */
export function useSuppressWebPanes(active: boolean, name: string): void {
  const holder = useRef<string | null>(null);
  if (!holder.current) holder.current = newSuppressHolder(name);
  useEffect(() => {
    if (!active) return undefined;
    const h = holder.current!;
    suppressWebPanes(h, true);
    return () => suppressWebPanes(h, false);
  }, [active]);
}
