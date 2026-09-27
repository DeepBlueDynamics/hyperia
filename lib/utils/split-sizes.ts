// Width/height of the drag gutter between split panes (px). Keep in sync with .splitpane_divider_*.
export const SPLIT_DIVIDER_PX = 8;

// CSS size for pane i: its fraction of the container minus its share of the dividers,
// so the panes plus (n-1) dividers sum to exactly 100% instead of overflowing by the gutters.
export function splitPaneSize(sizes: readonly number[], i: number, dividerPx = SPLIT_DIVIDER_PX): string {
  const pct = sizes[i] * 100;
  const gutter = Math.max(0, sizes.length - 1) * dividerPx * sizes[i];
  if (gutter === 0) return `${pct}%`;
  return `calc(${pct}% - ${gutter}px)`;
}
