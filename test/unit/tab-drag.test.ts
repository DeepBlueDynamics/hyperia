import test from 'ava';

import {dropIndexForX, reorderOffsets, type TabMetrics} from '../../lib/utils/tab-drag';

// Four 100px tabs in a row: [0,100) [100,200) [200,300) [300,400).
const even: TabMetrics = {
  starts: [0, 100, 200, 300],
  widths: [100, 100, 100, 100]
};

// What the strip looks like once it fills up and flex stops handing every tab
// the same width — the case a fixed one-tab-width shift gets wrong.
const uneven: TabMetrics = {
  starts: [0, 120, 380, 480],
  widths: [120, 260, 100, 140]
};

/** The order `metrics` ends up in when the tab at `from` is dropped at `to`. */
const applyMove = (length: number, from: number, to: number) => {
  const order = [...Array(length).keys()];
  order.splice(from, 1);
  order.splice(to, 0, from);
  return order;
};

test('dropIndexForX: holding a tab still leaves it where it started', (t) => {
  // Cursor in the middle of tab 1, which is the tab being dragged.
  t.is(dropIndexForX(even, 1, 150), 1);
});

test('dropIndexForX: counts only the midpoints the cursor has passed', (t) => {
  // Dragging tab 0 rightwards. Midpoints of the others: 150, 250, 350.
  t.is(dropIndexForX(even, 0, 10), 0);
  t.is(dropIndexForX(even, 0, 149), 0);
  t.is(dropIndexForX(even, 0, 151), 1);
  t.is(dropIndexForX(even, 0, 251), 2);
  t.is(dropIndexForX(even, 0, 351), 3);
});

test('dropIndexForX: dragging leftwards lands on the mirrored slots', (t) => {
  // Dragging tab 3 leftwards. Midpoints of the others: 50, 150, 250.
  t.is(dropIndexForX(even, 3, 390), 3);
  t.is(dropIndexForX(even, 3, 249), 2);
  t.is(dropIndexForX(even, 3, 149), 1);
  t.is(dropIndexForX(even, 3, 49), 0);
});

test('dropIndexForX: clamps to the strip past either end', (t) => {
  t.is(dropIndexForX(even, 2, -500), 0);
  t.is(dropIndexForX(even, 2, 5000), 3);
});

test('dropIndexForX: uses each tab midpoint, not a uniform width', (t) => {
  // Dragging tab 0. Remaining midpoints: 120+130=250, 380+50=430, 480+70=550.
  t.is(dropIndexForX(uneven, 0, 249), 0);
  t.is(dropIndexForX(uneven, 0, 251), 1);
  t.is(dropIndexForX(uneven, 0, 429), 1);
  t.is(dropIndexForX(uneven, 0, 431), 2);
});

test('reorderOffsets: nothing moves when the tab is over its own slot', (t) => {
  t.deepEqual(reorderOffsets(even, 2, 2), [0, 0, 0, 0]);
});

test('reorderOffsets: dragging right slides the tabs passed over to the left', (t) => {
  // Tab 0 goes to slot 2, so tabs 1 and 2 each shift one width left and tab 0
  // travels two widths right. Tab 3 is beyond the move and stays put.
  t.deepEqual(reorderOffsets(even, 0, 2), [200, -100, -100, 0]);
});

test('reorderOffsets: dragging left slides the tabs passed over to the right', (t) => {
  t.deepEqual(reorderOffsets(even, 3, 1), [0, 100, 100, -200]);
});

test('reorderOffsets: offsets close the gap exactly when widths differ', (t) => {
  const from = 1;
  const to = 3;
  const offsets = reorderOffsets(uneven, from, to);

  // Every tab, moved by its offset, must sit flush against the previous one in
  // the new order — no gap and no overlap. This is what a fixed one-width shift
  // cannot do once tabs stop being equal width.
  let expected = uneven.starts[0];
  for (const i of applyMove(uneven.starts.length, from, to)) {
    t.is(uneven.starts[i] + offsets[i], expected, `tab ${i} is not flush`);
    expected += uneven.widths[i];
  }
});

test('reorderOffsets: the strip still ends where it began', (t) => {
  const offsets = reorderOffsets(uneven, 3, 0);
  const order = applyMove(uneven.starts.length, 3, 0);
  const last = order[order.length - 1];
  const totalWidth = uneven.widths.reduce((a, b) => a + b, 0);

  t.is(uneven.starts[order[0]] + offsets[order[0]], uneven.starts[0]);
  t.is(uneven.starts[last] + offsets[last] + uneven.widths[last], uneven.starts[0] + totalWidth);
});
