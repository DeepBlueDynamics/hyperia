import test from 'ava';

import {ERR_ABORTED, initialLoadState, nextLoadState} from '../../app/utils/web-pane-loading';
import type {WebPaneLoadEvent, WebPaneLoadState} from '../../app/utils/web-pane-loading';

const mainNav: WebPaneLoadEvent = {type: 'start-navigation', isMainFrame: true, isSameDocument: false};
const subNav: WebPaneLoadEvent = {type: 'start-navigation', isMainFrame: false, isSameDocument: false};
const commit: WebPaneLoadEvent = {type: 'commit'};
const abort: WebPaneLoadEvent = {type: 'fail-load', isMainFrame: true, errorCode: ERR_ABORTED, provisional: true};

// Fold a sequence of events, returning the final state and `loading` after each.
function run(events: WebPaneLoadEvent[], start: WebPaneLoadState = initialLoadState) {
  let s = start;
  const loading = events.map((ev) => {
    s = nextLoadState(s, ev);
    return s.loading;
  });
  return {s, loading};
}

// Mirrors the manager: settle an abort against the navSeq seen when it happened.
const settleNow = (s: WebPaneLoadState): WebPaneLoadEvent => ({type: 'abort-settle', navSeq: s.navSeq});

test('a cross-document main-frame navigation starts loading', (t) => {
  t.deepEqual(nextLoadState(initialLoadState, mainNav), {loading: true, pending: true, navSeq: 1});
});

test('subframe and same-document navigations never start loading', (t) => {
  t.is(nextLoadState(initialLoadState, subNav), initialLoadState);
  t.is(
    nextLoadState(initialLoadState, {type: 'start-navigation', isMainFrame: true, isSameDocument: true}),
    initialLoadState
  );
});

test('main-frame finish clears loading even while subframes keep loading', (t) => {
  const {loading} = run([
    mainNav,
    commit,
    subNav,
    {type: 'finish-load'},
    // late ad iframe after the page finished
    subNav,
    {type: 'fail-load', isMainFrame: false, errorCode: -105, provisional: true}
  ]);
  t.deepEqual(loading, [true, true, true, false, false, false]);
});

test("the old page's finish does not clear loading while a new navigation is pending", (t) => {
  const {s, loading} = run([mainNav, commit, mainNav, {type: 'finish-load'}, {type: 'stop-loading'}]);
  t.deepEqual(loading, [true, true, true, true, true]);
  t.true(s.pending);
  // Once the new page commits, its own finish clears it.
  t.false(run([commit, {type: 'finish-load'}], s).s.loading);
});

test('main-frame failure clears loading and pending, subframe failure does not', (t) => {
  const pending = nextLoadState(initialLoadState, mainNav);
  t.deepEqual(nextLoadState(pending, {type: 'fail-load', isMainFrame: true, errorCode: -105, provisional: false}), {
    loading: false,
    pending: false,
    navSeq: 1
  });
  t.is(nextLoadState(pending, {type: 'fail-load', isMainFrame: false, errorCode: -105, provisional: false}), pending);
});

test('an abort with no replacement navigation clears loading on settle', (t) => {
  // A never-finishing iframe keeps the page loading; the main frame then aborts (download).
  let s = run([mainNav, commit, subNav, mainNav]).s;
  s = nextLoadState(s, abort);
  t.true(s.loading);
  s = nextLoadState(s, settleNow(s));
  t.deepEqual(s, {loading: false, pending: false, navSeq: 2});
});

test('an abort followed by a new navigation keeps loading', (t) => {
  let s = run([mainNav]).s;
  s = nextLoadState(s, abort);
  const settle = settleNow(s);
  s = nextLoadState(s, mainNav);
  s = nextLoadState(s, settle);
  t.true(s.loading);
  t.true(s.pending);
});

test('stop clears loading and pending', (t) => {
  const s = run([mainNav]).s;
  t.deepEqual(nextLoadState(s, {type: 'stop'}), {loading: false, pending: false, navSeq: 1});
});

test('did-stop-loading clears loading only when nothing is pending', (t) => {
  const committed = run([mainNav, commit]).s;
  t.false(nextLoadState(committed, {type: 'stop-loading'}).loading);
  const pending = run([mainNav]).s;
  t.true(nextLoadState(pending, {type: 'stop-loading'}).loading);
});

test('no change returns the same state', (t) => {
  t.is(nextLoadState(initialLoadState, {type: 'stop'}), initialLoadState);
  t.is(nextLoadState(initialLoadState, {type: 'finish-load'}), initialLoadState);
});

test('a late abort of the old navigation does not clear the new pending one', (t) => {
  const oldNav: WebPaneLoadEvent = {...mainNav, url: 'https://a.test/'};
  const newNav: WebPaneLoadEvent = {...mainNav, url: 'https://b.test/'};
  let {s} = run([oldNav, newNav, {...abort, url: 'https://a.test/'}]);
  t.true(s.pending);
  s = nextLoadState(s, settleNow(s));
  t.true(s.loading);
});
