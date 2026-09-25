import test from 'ava';

import {CTRL_CARET, ctrlCaretSequence} from '../../lib/utils/ctrl-caret';

test('Ctrl+Shift+6 and Ctrl+^ send RS (0x1E)', (t) => {
  t.is(CTRL_CARET.charCodeAt(0), 0x1e);
  t.is(ctrlCaretSequence({type: 'keydown', ctrlKey: true, shiftKey: true, key: '^', code: 'Digit6'}), CTRL_CARET);
  t.is(ctrlCaretSequence({type: 'keydown', ctrlKey: true, shiftKey: true, key: '6', code: 'Digit6'}), CTRL_CARET);
});

test('other chords stay with xterm', (t) => {
  t.is(ctrlCaretSequence({type: 'keyup', ctrlKey: true, shiftKey: true, key: '^', code: 'Digit6'}), null);
  t.is(ctrlCaretSequence({type: 'keydown', ctrlKey: true, shiftKey: false, key: '6', code: 'Digit6'}), null);
  t.is(ctrlCaretSequence({type: 'keydown', ctrlKey: false, shiftKey: true, key: '^', code: 'Digit6'}), null);
  t.is(
    ctrlCaretSequence({type: 'keydown', ctrlKey: true, altKey: true, shiftKey: true, key: '^', code: 'Digit6'}),
    null
  );
});
