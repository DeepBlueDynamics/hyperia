/**
 * Where one click of a tab-strip scroll arrow (or one wheel notch) should land.
 *
 * All positions are in the strip's scroll-content coordinates (0 = the first
 * tab's left edge at scrollLeft 0). The strip's left edge always lands on a tab
 * boundary, so the leftmost visible tab is never cut in half.
 *
 * Which tab a step reveals depends on the tab cut off at the edge you're
 * scrolling toward:
 * - more than half of it already showing: reveal it AND the next one, since it's
 *   nearly visible and one step shouldn't stop just short of it;
 * - half or more of it covered: reveal just that tab;
 * - nothing cut off (the edge sits on a boundary): reveal the next hidden tab.
 *
 * Scrolling right lands on the smallest boundary that fits the target tab
 * entirely, or on `max` (scroll end, last tab flush right) if none does.
 * Scrolling left lands on the target tab's own left edge.
 */
export interface TabSpan {
  left: number;
  right: number;
}

const EPS = 1;

export const nextScrollStop = (
  tabs: TabSpan[],
  from: number,
  viewWidth: number,
  max: number,
  dir: 1 | -1
): number | null => {
  if (!tabs.length || max <= 0) return null;
  const clamp = (x: number) => Math.min(Math.max(x, 0), max);

  if (dir > 0) {
    if (from >= max - EPS) return null;
    const viewRight = from + viewWidth;
    const cut = tabs.findIndex((t) => t.right > viewRight + EPS);
    if (cut < 0) return max;
    const width = tabs[cut].right - tabs[cut].left;
    const shown = width > 0 ? Math.max(0, viewRight - tabs[cut].left) / width : 0;
    const target = shown > 0.5 && cut + 1 < tabs.length ? cut + 1 : cut;
    if (target === tabs.length - 1) return max;
    const need = tabs[target].right - viewWidth;
    const boundary = tabs.map((t) => t.left).find((x) => x >= need - EPS && x > from + EPS);
    return clamp(boundary === undefined ? max : boundary);
  }

  if (from <= EPS) return null;
  let cut = -1;
  for (let i = tabs.length - 1; i >= 0; i--) {
    if (tabs[i].left < from - EPS) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return 0;
  const width = tabs[cut].right - tabs[cut].left;
  const shown = width > 0 ? Math.max(0, tabs[cut].right - from) / width : 0;
  const target = shown > 0.5 && cut > 0 ? cut - 1 : cut;
  return clamp(tabs[target].left);
};
