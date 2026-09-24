import test from 'ava';

import {clipsVertically} from '../../lib/utils/pin-layout-scroll';

test('clipping containers are pinned; real scroll areas are not', (t) => {
  t.true(clipsVertically('hidden'));
  t.true(clipsVertically('clip'));
  t.false(clipsVertically('auto'));
  t.false(clipsVertically('scroll'));
  t.false(clipsVertically('visible'));
});
