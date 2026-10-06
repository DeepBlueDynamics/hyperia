// Merges the window-level top toasts from several renderer sources (agent
// create-consent cards, the agent "waiting" pill, the consent "waiting" pill)
// into ONE list for the native toast layer (app/toast-layer.ts), so each source
// can update independently without clobbering the others. Pure — the IPC
// transport is injected (lib/toast-layer.ts) so this is unit-testable.

import type {ToastLayerItem} from '../../app/toast-layer';

export type {ToastLayerAnchor, ToastLayerItem, ToastLayerButton} from '../../app/toast-layer';

export interface ToastLayerHub {
  /** Replace `source`'s items. Lower `order` renders higher up. */
  set(source: string, order: number, items: ToastLayerItem[]): void;
  /** Current merged list (sources by order, then insertion). */
  items(): ToastLayerItem[];
}

export function createToastLayerHub(send: (items: ToastLayerItem[]) => void): ToastLayerHub {
  const sources = new Map<string, {order: number; items: ToastLayerItem[]}>();
  let last = '';
  const merged = () =>
    Array.from(sources.values())
      .sort((a, b) => a.order - b.order)
      .flatMap((s) => s.items);
  return {
    set(source, order, items) {
      if (items.length === 0) sources.delete(source);
      else sources.set(source, {order, items});
      const next = merged();
      // Skip identical re-sends (React effects re-run on unrelated renders).
      const sig = JSON.stringify(next);
      if (sig === last) return;
      last = sig;
      send(next);
    },
    items: merged
  };
}
