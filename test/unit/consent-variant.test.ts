import test from 'ava';

import {SUBJECT_MAX, consentSubject, consentTargetName, consentVariant} from '../../lib/utils/consent-variant';

// The consent prompt has three variants keyed off `action`. They share one
// row layout; these tests pin which rows each shows and its wording.

test('pane access: interactive scope + duration rows, flashing-tab tail', (t) => {
  for (const action of [undefined, 'drive', 'cap:audio']) {
    const v = consentVariant(action);
    t.is(v.kind, 'access');
    t.is(v.verb, ' wants to control ');
    t.is(v.accessChip, null);
    t.true(v.showDuration);
    t.is(v.tail, '— its tab is flashing 🔔. Approving releases the waiting operation.');
  }
});

test('messaging: fixed "This recipient" chip, keeps the For row, delivery tail', (t) => {
  const v = consentVariant('message:agent:bob');
  t.is(v.kind, 'message');
  t.is(v.verb, ' wants to send a message to ');
  t.is(v.accessChip, 'This recipient');
  t.true(v.showDuration);
  t.is(v.tail, '— approving delivers the waiting message.');
  t.false(v.tail.includes('flashing'));
});

test('binding: fixed "This pane" chip, no For row, mailbox tail', (t) => {
  const v = consentVariant('bind:alice');
  t.is(v.kind, 'bind');
  t.is(v.verb, ' wants to associate its mailbox with ');
  t.is(v.accessChip, 'This pane');
  t.false(v.showDuration);
  t.is(v.tail, '— approving links its mailbox to this pane.');
});

test('target name: messaging prefers the recipient agent label over the pane', (t) => {
  const req = {targetPane: 'p-1234567890', action: 'message:agent:team/bob', recipientLabel: 'team/bob-label'};
  t.is(consentTargetName(req, 'shell pane'), 'team/bob-label');
  // Older sidecar without recipientLabel: the agent name from the action.
  t.is(consentTargetName({...req, recipientLabel: undefined}, 'shell pane'), 'team/bob');
  t.is(consentTargetName({...req, recipientLabel: '  '}, undefined), 'team/bob');
});

test('target name: pane recipients and access use the pane name, id fragment only as a last resort', (t) => {
  t.is(consentTargetName({targetPane: 'abcdef0123', action: 'message:pane:abcdef0123'}, 'Build 🔧'), 'Build 🔧');
  t.is(consentTargetName({targetPane: 'abcdef0123', action: 'drive', recipientLabel: 'ignored'}, 'Build'), 'Build');
  t.is(consentTargetName({targetPane: 'abcdef0123', action: 'drive'}), 'pane abcdef01');
  t.is(consentTargetName({targetPane: 'abcdef0123', action: 'bind:alice'}, 'Mail pane'), 'Mail pane');
  t.is(consentTargetName({targetPane: '__audio__', action: 'drive'}, 'x'), '🔊 audio on this machine');
});

test('subject: messaging only, whitespace-collapsed, never a body', (t) => {
  t.deepEqual(consentSubject({action: 'message:agent:bob', subject: '  Weekly\n status  '}), {
    text: 'Weekly status',
    full: 'Weekly status'
  });
  t.is(consentSubject({action: 'message:agent:bob'}), null);
  t.is(consentSubject({action: 'message:agent:bob', subject: '   '}), null);
  t.is(consentSubject({action: 'drive', subject: 'not mail'}), null);
  t.is(consentSubject({action: 'bind:alice', subject: 'not mail'}), null);
});

test('subject: long subjects are truncated with an ellipsis, full text kept', (t) => {
  const long = 'Status report '.repeat(12).trim();
  const s = consentSubject({action: 'message:agent:bob', subject: long});
  t.truthy(s);
  t.is(s!.full, long);
  t.true(s!.text.endsWith('…'));
  t.true(Array.from(s!.text).length <= SUBJECT_MAX);
  // Code points, not UTF-16 units: an emoji at the cut is never split.
  const emoji = consentSubject({action: 'message:agent:bob', subject: '🦩'.repeat(20)}, 10);
  t.is(emoji!.text, '🦩'.repeat(9) + '…');
});
