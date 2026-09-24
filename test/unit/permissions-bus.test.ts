import test from 'ava';

import {
  clearRequest,
  expireRequest,
  hasRequests,
  reviveRequest,
  setRequest,
  subscribeAllRequests,
  subscribeExpiredRequests,
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
