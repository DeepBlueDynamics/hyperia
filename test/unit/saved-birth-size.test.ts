import test from 'ava';

import {savedBirthSize} from '../../lib/utils/saved-birth-size';

test('a restored shell is born at its saved grid size', (t) => {
  t.deepEqual(savedBirthSize({cols: 137, rows: 68}), {cols: 137, rows: 68});
});

test('missing or nonsense sizes fall back to the spawn default', (t) => {
  t.deepEqual(savedBirthSize({}), {});
  t.deepEqual(savedBirthSize(undefined), {});
  t.deepEqual(savedBirthSize({cols: 0, rows: 24}), {});
  t.deepEqual(savedBirthSize({cols: 80.5, rows: 24}), {});
  t.deepEqual(savedBirthSize({cols: '120', rows: 30}), {});
  t.deepEqual(savedBirthSize({cols: 99999, rows: 30}), {});
});
