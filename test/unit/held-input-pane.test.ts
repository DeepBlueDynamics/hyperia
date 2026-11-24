import test from 'ava';

import {paneBoxFrom, pinnedPane, samePaneBox} from '../../lib/utils/held-input-pane';

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  bottom: top + height
});

test('pinnedPane: the one pane all held prompts are about', (t) => {
  t.is(pinnedPane([]), null);
  t.is(pinnedPane([{pane: 'a'}]), 'a');
  t.is(pinnedPane([{pane: 'a'}, {pane: 'a'}]), 'a');
  t.is(pinnedPane([{pane: 'a'}, {pane: 'b'}]), null, 'two panes: window corner');
  t.is(pinnedPane([{pane: ''}]), null);
});

test('paneBoxFrom: starts under the top bar, or at the pane top without one', (t) => {
  t.deepEqual(paneBoxFrom(rect(500, 40, 500, 700), rect(500, 40, 500, 28)), {x: 500, y: 68, width: 500});
  t.deepEqual(paneBoxFrom(rect(500, 40, 500, 700), null), {x: 500, y: 40, width: 500});
  t.deepEqual(paneBoxFrom(rect(500, 40, 500, 700), rect(0, 0, 0, 0)), {x: 500, y: 40, width: 500});
});

test('paneBoxFrom: a pane that is not on screen gives null', (t) => {
  t.is(paneBoxFrom(rect(0, 0, 0, 0), null), null);
  t.is(paneBoxFrom(rect(10, 10, 300, 0), null), null);
});

test('samePaneBox', (t) => {
  t.true(samePaneBox(null, null));
  t.true(samePaneBox({x: 1, y: 2, width: 3}, {x: 1, y: 2, width: 3}));
  t.false(samePaneBox({x: 1, y: 2, width: 3}, {x: 1, y: 2, width: 4}));
  t.false(samePaneBox(null, {x: 1, y: 2, width: 3}));
});
