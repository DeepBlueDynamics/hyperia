import test from 'ava';

import {createToastLayerHub} from '../../lib/utils/toast-layer-hub';
import type {ToastLayerItem} from '../../lib/utils/toast-layer-hub';

const card = (id: string): ToastLayerItem => ({id, kind: 'card', text: `${id} wants to open a web pane.`});
const pill = (id: string): ToastLayerItem => ({id, kind: 'pill', text: `${id} waiting`});

test('hub: sources merge by order, not by who spoke last', (t) => {
  const sent: ToastLayerItem[][] = [];
  const hub = createToastLayerHub((items) => sent.push(items));
  hub.set('consent-pill', 1, [pill('consent')]);
  hub.set('agent-toast', 0, [card('a'), card('b')]);
  t.deepEqual(
    hub.items().map((i) => i.id),
    ['a', 'b', 'consent']
  );
  t.is(sent.length, 2);
});

test('hub: an empty list removes the source and sends the rest', (t) => {
  const sent: ToastLayerItem[][] = [];
  const hub = createToastLayerHub((items) => sent.push(items));
  hub.set('agent-toast', 0, [card('a')]);
  hub.set('consent-pill', 1, [pill('c')]);
  hub.set('agent-toast', 0, []);
  t.deepEqual(
    sent[sent.length - 1].map((i) => i.id),
    ['c']
  );
  hub.set('consent-pill', 1, []);
  t.deepEqual(sent[sent.length - 1], [], 'last send is the empty list that hides the layer');
});

test('hub: identical re-sets do not re-send', (t) => {
  let sends = 0;
  const hub = createToastLayerHub(() => sends++);
  hub.set('agent-toast', 0, [card('a')]);
  hub.set('agent-toast', 0, [card('a')]);
  hub.set('agent-toast', 0, [{...card('a')}]);
  t.is(sends, 1);
  hub.set('agent-toast', 0, [card('a'), card('b')]);
  t.is(sends, 2);
});
