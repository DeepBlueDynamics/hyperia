import test from 'ava';

import {bottomRightBounds, topCenterBounds} from '../../app/utils/toast-layer-bounds';

test('topCenterBounds: centers the content-sized view at the top edge', (t) => {
  t.deepEqual(topCenterBounds(1000, 400, 120, 1), {x: 300, y: 0, width: 400, height: 120});
});

test('topCenterBounds: scales the page-reported CSS size by the host zoom', (t) => {
  // Linux boots the UI at 1.2 — the view must cover 1.2x the CSS box.
  t.deepEqual(topCenterBounds(1200, 400, 100, 1.2), {x: 360, y: 0, width: 480, height: 120});
});

test('topCenterBounds: never wider than the window, never zero-sized', (t) => {
  t.deepEqual(topCenterBounds(300, 400, 120, 1), {x: 0, y: 0, width: 300, height: 120});
  t.deepEqual(topCenterBounds(800, 0, 0, 1), {x: 400, y: 0, width: 1, height: 1});
  t.deepEqual(topCenterBounds(800, 100, 50, 0), {x: 350, y: 0, width: 100, height: 50}, 'bad zoom falls back to 1');
});

test('bottomRightBounds: pins the content-sized view to the bottom-right corner', (t) => {
  t.deepEqual(bottomRightBounds(1000, 800, 300, 120, 1), {x: 700, y: 680, width: 300, height: 120});
  t.deepEqual(bottomRightBounds(1200, 800, 300, 100, 1.2), {x: 840, y: 680, width: 360, height: 120});
});

test('bottomRightBounds: never larger than the window', (t) => {
  t.deepEqual(bottomRightBounds(200, 100, 300, 400, 1), {x: 0, y: 0, width: 200, height: 100});
  t.deepEqual(bottomRightBounds(800, 600, 0, 0, 1), {x: 799, y: 599, width: 1, height: 1});
});
