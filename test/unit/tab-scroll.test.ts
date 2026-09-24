import test from 'ava';

import {nextScrollStop, type TabSpan} from '../../lib/utils/tab-scroll';

// Ten 120px tabs: [0,120) [120,240) ... [1080,1200). A 300px view shows two
// whole tabs and half-ish of a third, so edges regularly cut a tab.
const tabs: TabSpan[] = Array.from({length: 10}, (_, i) => ({left: i * 120, right: (i + 1) * 120}));
const VIEW = 300;
const MAX = 1200 - VIEW; // 900

test('right: a cut tab with more than half showing reveals it and the next', (t) => {
  // 320px view from 0: tab 2 [240,360) shows 80/120 (67%) → reveal tabs 2 and 3.
  // Tab 3 ends at 480 → need scrollLeft >= 160 → smallest boundary is 240.
  t.is(nextScrollStop(tabs, 0, 320, 1200 - 320, 1), 240);
});

test('right: a cut tab with half or more covered reveals just that tab', (t) => {
  // from 0, view 300: tab 2 shows exactly 60/120 = 50% → only tab 2.
  // Tab 2 ends at 360 → need >= 60 → smallest boundary is 120.
  t.is(nextScrollStop(tabs, 0, VIEW, MAX, 1), 120);
  // view 270: tab 2 shows 30/120 (25%) → only tab 2, ends 360 → need >= 90 → 120.
  t.is(nextScrollStop(tabs, 0, 270, 1200 - 270, 1), 120);
});

test('right: edge on a boundary reveals the next hidden tab', (t) => {
  // view 240 from 0 shows tabs 0-1 exactly; tab 2 is 0% shown → reveal tab 2.
  // Tab 2 ends at 360 → need >= 120 → 120.
  t.is(nextScrollStop(tabs, 0, 240, 1200 - 240, 1), 120);
});

test('right: always lands on a tab boundary or the scroll end', (t) => {
  const stops = new Set([...tabs.map((x) => x.left), MAX]);
  let from = 0;
  for (let i = 0; i < 20; i++) {
    const next = nextScrollStop(tabs, from, VIEW, MAX, 1);
    if (next === null) break;
    t.true(stops.has(next), `stop ${next} is a boundary or the end`);
    t.true(next > from, 'makes progress');
    from = next;
  }
  t.is(from, MAX, 'reaches the end');
  t.is(nextScrollStop(tabs, MAX, VIEW, MAX, 1), null, 'no step past the end');
});

test('right: revealing the last tab lands flush right at the end', (t) => {
  // from 720, view [720,1020): tab 8 [960,1080) shows 60/120 → just tab 8.
  // Tab 8 isn't last, so land on the boundary that fits it: need >= 780 → 840.
  t.is(nextScrollStop(tabs, 720, VIEW, MAX, 1), 840);
  // from 840, view [840,1140): tab 9 [1080,1200) is the last → scroll end.
  t.is(nextScrollStop(tabs, 840, VIEW, MAX, 1), MAX);
});

test('left: a cut tab with more than half showing reveals it and the previous', (t) => {
  // from 520 (off-boundary, e.g. after a manual scroll): tab 4 [480,600) shows
  // 80/120 on the left edge → reveal tab 4 and tab 3 → land on tab 3's left, 360.
  t.is(nextScrollStop(tabs, 520, VIEW, MAX, -1), 360);
});

test('left: a cut tab with half or more covered reveals just that tab', (t) => {
  // from 540: tab 4 shows 60/120 = 50% → only tab 4 → 480.
  t.is(nextScrollStop(tabs, 540, VIEW, MAX, -1), 480);
});

test('left: edge on a boundary reveals the previous tab', (t) => {
  t.is(nextScrollStop(tabs, 480, VIEW, MAX, -1), 360);
  t.is(nextScrollStop(tabs, 120, VIEW, MAX, -1), 0);
  t.is(nextScrollStop(tabs, 0, VIEW, MAX, -1), null, 'no step past the start');
});

test('uneven widths: still boundary-aligned and fully reveals the target', (t) => {
  // Widths 200, 80, 260, 120, 90 → lefts 0, 200, 280, 540, 660; content 750.
  const lefts = [0, 200, 280, 540, 660];
  const widths = [200, 80, 260, 120, 90];
  const uneven = lefts.map((l, i) => ({left: l, right: l + widths[i]}));
  const view = 300;
  const max = 750 - view; // 450
  // from 0, view [0,300): tab 2 [280,540) shows 20/260 → only tab 2, ends 540
  // → need >= 240 → smallest boundary >= 240 is 280.
  const next = nextScrollStop(uneven, 0, view, max, 1);
  t.is(next, 280);
  t.true(next! + view >= uneven[2].right, 'tab 2 fully visible');
});

test('no overflow: nothing to scroll', (t) => {
  t.is(nextScrollStop(tabs.slice(0, 2), 0, VIEW, 0, 1), null);
  t.is(nextScrollStop([], 0, VIEW, 100, 1), null);
});
