/* eslint-disable eslint-comments/disable-enable-pair */

import test from 'ava';

import {restoredTabName} from '../../lib/utils/restored-tab-name';

// R06 (#183): the layout was captured while the tab was named "Bob", then saved
// as "Bob two". Restoring must use the saved entry name, not the baked-in one.
test('a restored tab is named after the saved entry, not the layout (Bob two, not Bob)', (t) => {
  t.is(restoredTabName('Bob two', ['Bob']), 'Bob two');
});

// R07 (#183): restoring a copy while the original is open must stay tellable
// apart with a file-style "(n)" suffix computed at restore time.
test('a restored name that matches an open tab gets a (2) suffix', (t) => {
  t.is(restoredTabName('Bob', ['Bob']), 'Bob (2)');
});

test('the suffix climbs past existing copies', (t) => {
  t.is(restoredTabName('Bob', ['Bob', 'Bob (2)']), 'Bob (3)');
});

test('the suffix is computed, never baked — a second restore does not stack "(2) (2)"', (t) => {
  // "Bob (2)" already open; restoring "Bob" again yields "Bob (3)", not "Bob (2) (2)".
  t.is(restoredTabName('Bob', ['Bob', 'Bob (2)']), 'Bob (3)');
});

test('no collision leaves the name unchanged', (t) => {
  t.is(restoredTabName('Alice', ['Bob', 'Carol']), 'Alice');
});
