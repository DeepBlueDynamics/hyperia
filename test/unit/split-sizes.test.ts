import test from 'ava';

import {SPLIT_DIVIDER_PX, splitPaneSize} from '../../lib/utils/split-sizes';

// Resolve a `calc(P% - Gpx)` / `P%` string against a container width.
const resolve = (css: string, container: number) => {
  const m = /^(?:calc\()?([\d.]+)%(?: - ([\d.]+)px\))?$/.exec(css);
  if (!m) throw new Error(`unparsed: ${css}`);
  return (Number(m[1]) / 100) * container - Number(m[2] ?? 0);
};

test('a single pane takes 100% with no gutter', (t) => {
  t.is(splitPaneSize([1], 0), '100%');
});

test('panes plus dividers fill the container exactly at any width', (t) => {
  for (const sizes of [
    [1 / 3, 1 / 3, 1 / 3],
    [0.5, 0.5],
    [0.2, 0.5, 0.3],
    [0.25, 0.25, 0.25, 0.25]
  ]) {
    for (const container of [400, 1280, 2560, 3840]) {
      const panes = sizes.map((_, i) => resolve(splitPaneSize(sizes, i), container));
      const total = panes.reduce((a, b) => a + b, 0) + (sizes.length - 1) * SPLIT_DIVIDER_PX;
      t.true(Math.abs(total - container) < 1e-6, `${JSON.stringify(sizes)} @ ${container}px -> ${total}`);
    }
  }
});

test('three equal columns each give up a third of the two 8px gutters', (t) => {
  t.is(splitPaneSize([0.5, 0.5], 0), 'calc(50% - 4px)');
  const col = resolve(splitPaneSize([1 / 3, 1 / 3, 1 / 3], 2), 1200);
  t.true(Math.abs(col - (400 - 16 / 3)) < 1e-6);
});
