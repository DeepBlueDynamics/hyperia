import test from 'ava';

import {ACK_TIMEOUT_MS, ackOverdue, newAckWatch, recordAck} from '../../app/bridge-watchdog';

test('a fresh connection is never overdue before its first ack', (t) => {
  const w = newAckWatch(0);
  // Old sidecars never ack; timing them out would reconnect-loop forever.
  t.false(ackOverdue(w, ACK_TIMEOUT_MS * 10));
});

test('overdue only once the ack gap passes the timeout', (t) => {
  const w = newAckWatch(0);
  recordAck(w, 1000);
  t.false(ackOverdue(w, 1000 + ACK_TIMEOUT_MS));
  t.true(ackOverdue(w, 1000 + ACK_TIMEOUT_MS + 1));
});

test('each ack resets the window', (t) => {
  const w = newAckWatch(0);
  recordAck(w, 5000);
  recordAck(w, 10000);
  t.false(ackOverdue(w, 10000 + ACK_TIMEOUT_MS));
  t.true(ackOverdue(w, 10000 + ACK_TIMEOUT_MS + 1));
});

test('an out-of-order ack never moves the clock backwards', (t) => {
  const w = newAckWatch(0);
  recordAck(w, 20000);
  recordAck(w, 1000);
  t.is(w.lastAckAt, 20000);
});

test('custom timeout is honoured', (t) => {
  const w = newAckWatch(0);
  recordAck(w, 0);
  t.true(ackOverdue(w, 501, 500));
  t.false(ackOverdue(w, 500, 500));
});
