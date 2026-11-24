// Where the held-input prompt goes: the top-right of the pane it is about,
// under that pane's top bar. Pure, so the choice is unit-testable.

export interface PaneBox {
  x: number;
  y: number;
  width: number;
}

interface RectLike {
  left: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** The one pane every held prompt is about, or null (none, or several). */
export function pinnedPane(held: {pane: string}[]): string | null {
  if (!held.length) return null;
  const pane = held[held.length - 1].pane;
  return pane && held.every((h) => h.pane === pane) ? pane : null;
}

/** The pane's box, starting below its top bar when it has one. Null if not on screen. */
export function paneBoxFrom(root: RectLike, band: RectLike | null): PaneBox | null {
  if (!(root.width > 0 && root.height > 0)) return null;
  const top = band && band.height > 0 ? band.bottom : root.top;
  return {x: Math.round(root.left), y: Math.round(top), width: Math.round(root.width)};
}

export const samePaneBox = (a: PaneBox | null, b: PaneBox | null): boolean =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width);
