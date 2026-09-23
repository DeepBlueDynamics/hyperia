/**
 * Geometry for the tab strip's drag-to-reorder animation (lib/components/tabs.tsx).
 *
 * Both functions work off a snapshot of the tabs' resting geometry taken when
 * the drag starts, expressed in the list's scroll-content space so that
 * wheel-scrolling mid-drag doesn't invalidate it. They are deliberately pure and
 * DOM-free: the strip animates by translating tabs *underneath* the cursor, so
 * getting this arithmetic wrong is both easy and hard to see, and it is the part
 * worth testing directly.
 */
export type TabMetrics = {
  /** Each tab's left edge at rest, in list scroll-content space. */
  starts: number[];
  /** Each tab's width at rest. */
  widths: number[];
};

/**
 * The slot a tab picked up from `from` would land in if dropped at `x`.
 *
 * Counts how many of the *other* tabs have their midpoint left of the cursor.
 * The dragged tab is excluded, which makes the result an index into the list as
 * it will look after the move — exactly what TERM_GROUP_REORDER wants, since it
 * splices the tab out first and then back in at `toIndex`.
 */
export const dropIndexForX = (metrics: TabMetrics, from: number, x: number): number => {
  let index = 0;
  for (let i = 0; i < metrics.starts.length; i++) {
    if (i !== from && metrics.starts[i] + metrics.widths[i] / 2 < x) {
      index++;
    }
  }
  return index;
};

/**
 * Pixel delta for every tab, from where it rests to where it belongs while a tab
 * is being carried from `from` to `to` — the gap that opens under the cursor.
 *
 * Re-laying the whole strip out from the snapshot beats the usual trick of
 * shifting the tabs between `from` and `to` by one tab width: `.tab_tab` is
 * `flex: 1 1 auto` clamped between 120px and 260px, so tabs are equal-width only
 * until the strip fills up, and past that a fixed shift opens a gap of the wrong
 * size and leaves the neighbours overlapping.
 */
export const reorderOffsets = (metrics: TabMetrics, from: number, to: number): number[] => {
  const order: number[] = [];
  for (let i = 0; i < metrics.starts.length; i++) {
    if (i !== from) {
      order.push(i);
    }
  }
  order.splice(to, 0, from);

  const offsets = new Array<number>(metrics.starts.length).fill(0);
  let x = metrics.starts[0] ?? 0;
  for (const i of order) {
    offsets[i] = x - metrics.starts[i];
    x += metrics.widths[i];
  }
  return offsets;
};
