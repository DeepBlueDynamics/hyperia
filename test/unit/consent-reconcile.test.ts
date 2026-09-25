import test from 'ava';

import {
  clearRequest,
  clearToast,
  hasAnyPrompts,
  reconcilePending,
  setRequest,
  setToast
} from '../../lib/permissions-bus';

test('prompts the sidecar no longer holds are dropped; live and newer ones stay', (t) => {
  setRequest({id: 'gone-req', requester: 'agent:a', targetPane: 'pane-1', action: 'drive'} as any);
  setToast({id: 'gone-toast', requester: 'agent:b', action: 'cap:manage'} as any);
  setToast({id: 'live-toast', requester: 'agent:c', action: 'cap:files'} as any);
  const snapshotAt = Date.now() + 1;
  // Arrives after the snapshot: must survive even though the snapshot lacks it.
  const panes = reconcilePending(new Set(['live-toast']), snapshotAt);
  t.deepEqual(panes, ['pane-1']);
  t.true(hasAnyPrompts());
  // Only the live toast remains.
  clearToast('live-toast');
  t.false(hasAnyPrompts());
});

test('a prompt first seen after the snapshot is kept', (t) => {
  const snapshotAt = Date.now() - 10_000;
  setRequest({id: 'new-req', requester: 'agent:a', targetPane: 'pane-2', action: 'drive'} as any);
  t.deepEqual(reconcilePending(new Set(), snapshotAt), []);
  t.true(hasAnyPrompts());
  clearRequest('pane-2', 'new-req');
  t.false(hasAnyPrompts());
});
