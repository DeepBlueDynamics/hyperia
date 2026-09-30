import test from 'ava';

import {
  clearRequest,
  clearToast,
  expireRequest,
  hasRequests,
  reviveRequest,
  setRequest,
  setToast,
  setToastsOccludeWebPanes,
  subscribeAllRequests,
  subscribeExpiredRequests,
  subscribePermsOverlay,
  type PermRequest
} from '../../lib/permissions-bus';

test.serial('consent requests for one pane remain isolated through resolve and snooze', (t) => {
  const pane = 'consent-test-pane';
  let active: PermRequest[] = [];
  let expired: PermRequest[] = [];
  const offActive = subscribeAllRequests((items) => {
    active = items;
  });
  const offExpired = subscribeExpiredRequests((items) => {
    expired = items;
  });
  try {
    const first = {id: 'consent-a', requester: 'alice', requesterPane: 'a', targetPane: pane};
    const second = {id: 'consent-b', requester: 'bob', requesterPane: 'b', targetPane: pane};
    setRequest(first);
    setRequest(second);
    t.deepEqual(
      active.map((req) => req.id),
      [first.id, second.id]
    );
    clearRequest(pane, first.id);
    t.deepEqual(
      active.map((req) => req.id),
      [second.id]
    );
    t.true(hasRequests(pane));
    // A late duplicate resolution must not dismiss another caller's prompt.
    clearRequest(pane, first.id);
    t.deepEqual(
      active.map((req) => req.id),
      [second.id]
    );
    expireRequest(pane, second.id);
    t.is(active.length, 0);
    t.deepEqual(
      expired.map((req) => req.id),
      [second.id]
    );
    t.true(hasRequests(pane));
    reviveRequest(pane, second.id);
    t.deepEqual(
      active.map((req) => req.id),
      [second.id]
    );
    t.is(expired.length, 0);
    clearRequest('another-pane', second.id);
    t.is(active.length, 1);
    clearRequest(pane, second.id);
    t.false(hasRequests(pane));
  } finally {
    clearRequest(pane);
    offActive();
    offExpired();
  }
});

test.serial('create toasts only freeze-swap web panes when the native toast layer is not in use (#297)', (t) => {
  let active: boolean | null = null;
  const off = subscribePermsOverlay((a) => {
    active = a;
  });
  try {
    setToast({id: 'toast-layer-a', requester: 'alice', action: 'create_web'});
    t.true(active, 'DOM toasts occlude by default');
    setToastsOccludeWebPanes(false);
    t.false(active, 'layer draws the toast above web panes — no overlay');
    setToastsOccludeWebPanes(true);
    t.true(active);
    clearToast('toast-layer-a');
    t.false(active);
  } finally {
    setToastsOccludeWebPanes(true);
    clearToast('toast-layer-a');
    off();
  }
});
