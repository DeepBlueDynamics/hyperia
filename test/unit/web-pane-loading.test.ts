import test from 'ava';

import {nextMainFrameLoading} from '../../app/utils/web-pane-loading';
import type {WebPaneLoadEvent} from '../../app/utils/web-pane-loading';

const mainNav: WebPaneLoadEvent = {type: 'start-navigation', isMainFrame: true, isSameDocument: false};

// Fold a sequence of events, returning the loading state after each.
function run(events: WebPaneLoadEvent[], start = false): boolean[] {
  let loading = start;
  return events.map((ev) => {
    const next = nextMainFrameLoading(loading, ev);
    if (next !== null) loading = next;
    return loading;
  });
}

test('a cross-document main-frame navigation starts loading', (t) => {
  t.is(nextMainFrameLoading(false, mainNav), true);
});

test('subframe and same-document navigations never start loading', (t) => {
  t.is(nextMainFrameLoading(false, {type: 'start-navigation', isMainFrame: false, isSameDocument: false}), null);
  t.is(nextMainFrameLoading(false, {type: 'start-navigation', isMainFrame: true, isSameDocument: true}), null);
});

test('main-frame finish clears loading even while subframes keep loading', (t) => {
  const states = run([
    mainNav,
    {type: 'start-navigation', isMainFrame: false, isSameDocument: false},
    {type: 'finish-load'},
    // late ad iframe after the page finished
    {type: 'start-navigation', isMainFrame: false, isSameDocument: false},
    {type: 'fail-load', isMainFrame: false, errorCode: -105}
  ]);
  t.deepEqual(states, [true, true, false, false, false]);
});

test('main-frame failure clears loading, subframe failure does not', (t) => {
  t.is(nextMainFrameLoading(true, {type: 'fail-load', isMainFrame: true, errorCode: -105}), false);
  t.is(nextMainFrameLoading(true, {type: 'fail-load', isMainFrame: false, errorCode: -105}), null);
});

test('an aborted main-frame load keeps the replacing navigation spinning', (t) => {
  t.is(nextMainFrameLoading(true, {type: 'fail-load', isMainFrame: true, errorCode: -3}), null);
});

test('stop and did-stop-loading clear loading', (t) => {
  t.is(nextMainFrameLoading(true, {type: 'stop'}), false);
  t.is(nextMainFrameLoading(true, {type: 'stop-loading'}), false);
});

test('no change reports null', (t) => {
  t.is(nextMainFrameLoading(false, {type: 'stop'}), null);
  t.is(nextMainFrameLoading(true, mainNav), null);
});
