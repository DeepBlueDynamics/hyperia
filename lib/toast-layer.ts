// Renderer side of the toast layer (see app/toast-layer.ts): a transparent
// native view above the window's web panes that hosts the top toasts, so they
// are visible over a LIVE web pane — no freeze-swap, no repaint (#297).
//
// Components keep owning their state; they hand the layer a plain description
// of what to show (setLayerToasts) and get clicks back (onToastLayerAction).
// If main reports the layer unavailable, components fall back to their DOM
// rendering and the old permissions-overlay freeze-swap.

import {ipcRenderer, webFrame} from 'electron';
import React from 'react';

import {setToastsOccludeWebPanes} from './permissions-bus';
import {createToastLayerHub} from './utils/toast-layer-hub';
import type {ToastLayerItem} from './utils/toast-layer-hub';

export type {ToastLayerItem, ToastLayerButton} from './utils/toast-layer-hub';

let available: boolean | null = null;
let probe: Promise<boolean> | null = null;

/**
 * Ask main once whether the native layer exists. Resolves false on any error.
 * A true answer also switches the permissions bus off the freeze-swap for
 * create toasts — the layer draws them over the live page instead.
 */
export function probeToastLayer(): Promise<boolean> {
  if (available !== null) return Promise.resolve(available);
  if (!probe) {
    probe = ipcRenderer
      .invoke('toast-layer:available')
      .then((ok: unknown) => !!ok)
      .catch(() => false)
      .then((ok) => {
        available = ok;
        setToastsOccludeWebPanes(!ok);
        return ok;
      });
  }
  return probe;
}

/** Synchronous view of the probe — false until it has resolved true. */
export function toastLayerReady(): boolean {
  return available === true;
}

// The host CSS variables the layer page mirrors (must match render.js THEME_VARS).
const THEME_VARS = [
  '--bg-elevated',
  '--bg-secondary',
  '--text-primary',
  '--text-secondary',
  '--accent-primary',
  '--accent-success',
  '--accent-danger',
  '--border-neutral',
  '--font-sans'
];

function themeSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const cs = getComputedStyle(document.documentElement);
    for (const name of THEME_VARS) {
      const v = cs.getPropertyValue(name).trim();
      if (v) out[name] = v;
    }
  } catch {
    /* no DOM — layer falls back to its own defaults */
  }
  return out;
}

const hub = createToastLayerHub((items) => {
  let zoom = 1;
  try {
    zoom = webFrame.getZoomFactor() || 1;
  } catch {
    /* keep 1 */
  }
  try {
    ipcRenderer.send('toast-layer:render', {items, theme: themeSnapshot(), zoom});
  } catch {
    /* main not ready */
  }
});

// Mirror the visible layer's rect as a no-drag box in the host DOM. The layer
// sits over the frameless window's top drag strip, and Windows hit-tests the
// host's drag region first, so without this a pill click started a window drag.
let noDragBox: HTMLDivElement | null = null;
try {
  ipcRenderer.on('toast-layer:bounds', (_e, b: {x: number; y: number; width: number; height: number} | null) => {
    if (!b) {
      if (noDragBox) noDragBox.style.display = 'none';
      return;
    }
    if (!noDragBox) {
      noDragBox = document.createElement('div');
      noDragBox.id = 'hy-toast-layer-no-drag';
      Object.assign(noDragBox.style, {position: 'fixed', zIndex: '2147483647', pointerEvents: 'none'});
      (noDragBox.style as any).webkitAppRegion = 'no-drag';
      document.body.appendChild(noDragBox);
    }
    let z = 1;
    try {
      z = webFrame.getZoomFactor() || 1;
    } catch {
      /* keep 1 */
    }
    // Window DIPs -> host CSS px.
    Object.assign(noDragBox.style, {
      display: 'block',
      left: `${b.x / z}px`,
      top: `${b.y / z}px`,
      width: `${b.width / z}px`,
      height: `${b.height / z}px`
    });
  });
} catch {
  /* no ipc (tests) */
}

/** Replace one source's toasts in the layer. Empty list = that source is gone. */
export function setLayerToasts(source: string, order: number, items: ToastLayerItem[]): void {
  hub.set(source, order, items);
}

export type ToastLayerAction = {toastId: string; buttonId: string};

/** Subscribe to clicks relayed from the layer. Returns the unsubscribe. */
export function onToastLayerAction(cb: (action: ToastLayerAction) => void): () => void {
  const handler = (_e: unknown, action: ToastLayerAction) => cb(action);
  ipcRenderer.on('toast-layer:action', handler);
  return () => {
    ipcRenderer.removeListener('toast-layer:action', handler);
  };
}

/** React hook: true once main has confirmed the native layer is usable. */
export function useToastLayer(): boolean {
  const [ready, setReady] = React.useState<boolean>(toastLayerReady());
  React.useEffect(() => {
    let alive = true;
    void probeToastLayer().then((ok) => {
      if (alive) setReady(ok);
    });
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}
