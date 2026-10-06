// Pure geometry for the toast layer (app/toast-layer.ts): where the transparent
// native view that hosts the window-level top toasts sits inside the window.
//
// The layer page reports its content size in ITS OWN CSS px (`cssW`/`cssH`);
// the native view wants window DIPs, which differ by the page zoom (Linux boots
// the UI at 1.2 — see lib/index.tsx). The view is anchored top-center and
// shrink-wrapped to the content so the transparent margins that still swallow
// clicks stay as small as possible.

export interface LayerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function topCenterBounds(contentWidth: number, cssW: number, cssH: number, zoom: number): LayerRect {
  const z = zoom > 0 ? zoom : 1;
  const width = Math.min(Math.max(1, Math.ceil(cssW * z)), Math.max(1, Math.floor(contentWidth)));
  const height = Math.max(1, Math.ceil(cssH * z));
  return {x: Math.max(0, Math.round((contentWidth - width) / 2)), y: 0, width, height};
}

// Bottom-right twin for the notice stack; the page's own padding is the margin.
export function bottomRightBounds(
  contentWidth: number,
  contentHeight: number,
  cssW: number,
  cssH: number,
  zoom: number
): LayerRect {
  const z = zoom > 0 ? zoom : 1;
  const w = Math.max(1, Math.floor(contentWidth));
  const h = Math.max(1, Math.floor(contentHeight));
  const width = Math.min(Math.max(1, Math.ceil(cssW * z)), w);
  const height = Math.min(Math.max(1, Math.ceil(cssH * z)), h);
  return {x: w - width, y: h - height, width, height};
}
