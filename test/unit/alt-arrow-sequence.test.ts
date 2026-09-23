import fs from 'fs';
import path from 'path';

import test from 'ava';

import {ALT_DOWN_SEQUENCE, ALT_UP_SEQUENCE, altArrowSequence} from '../../lib/utils/alt-arrow-sequence';

const CTRL_UP = '\u001b[1;5A';
const CTRL_DOWN = '\u001b[1;5B';

test('bare Alt+ArrowUp is CSI modifier 3, not xterm 5.5 Ctrl+Up', (t) => {
  const sequence = altArrowSequence({altKey: true, key: 'ArrowUp'});
  t.is(sequence, ALT_UP_SEQUENCE);
  t.is(sequence, '\u001b[1;3A');
  t.not(sequence, CTRL_UP);
  t.deepEqual(Buffer.from(sequence ?? ''), Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x41]));
});

test('bare Alt+ArrowDown is CSI modifier 3, not Ctrl+Down', (t) => {
  const sequence = altArrowSequence({altKey: true, key: 'ArrowDown'});
  t.is(sequence, ALT_DOWN_SEQUENCE);
  t.is(sequence, '\u001b[1;3B');
  t.not(sequence, CTRL_DOWN);
  t.deepEqual(Buffer.from(sequence ?? ''), Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x42]));
});

test('Electron key names Up and Down with Alt use the same sequences', (t) => {
  t.is(altArrowSequence({altKey: true, key: 'Up'}), ALT_UP_SEQUENCE);
  t.is(altArrowSequence({altKey: true, key: 'Down'}), ALT_DOWN_SEQUENCE);
});

test('Alt+Left and Alt+Right stay unclaimed so directory history keeps them', (t) => {
  t.is(altArrowSequence({altKey: true, key: 'ArrowLeft'}), null);
  t.is(altArrowSequence({altKey: true, key: 'ArrowRight'}), null);
  t.is(altArrowSequence({altKey: true, key: 'Left'}), null);
  t.is(altArrowSequence({altKey: true, key: 'Right'}), null);
});

test('Ctrl+Up, Shift+Up, and plain Up are not claimed', (t) => {
  t.is(altArrowSequence({ctrlKey: true, key: 'ArrowUp'}), null);
  t.is(altArrowSequence({altKey: true, ctrlKey: true, key: 'ArrowUp'}), null);
  t.is(altArrowSequence({shiftKey: true, key: 'ArrowUp'}), null);
  t.is(altArrowSequence({altKey: true, shiftKey: true, key: 'ArrowUp'}), null);
  t.is(altArrowSequence({key: 'ArrowUp'}), null);
  t.is(altArrowSequence({altKey: true, key: 'ArrowDown', metaKey: true}), null);
});

test('a missing key or Alt with no arrow is not claimed', (t) => {
  t.is(altArrowSequence({altKey: true}), null);
  t.is(altArrowSequence({altKey: true, key: 'a'}), null);
  t.is(altArrowSequence({}), null);
});

test('keyup does not emit and does not claim the key', (t) => {
  t.is(altArrowSequence({type: 'keyup', altKey: true, key: 'ArrowUp'}), null);
  t.is(altArrowSequence({type: 'keyup', altKey: true, key: 'ArrowDown'}), null);
  t.is(altArrowSequence({type: 'keypress', altKey: true, key: 'Up'}), null);
});

test('keydown Alt+Up is still the parameter-3 sequence', (t) => {
  t.is(altArrowSequence({type: 'keydown', altKey: true, key: 'ArrowUp'}), ALT_UP_SEQUENCE);
  t.is(altArrowSequence({type: 'keydown', altKey: true, ctrlKey: true, key: 'ArrowDown'}), null);
  t.is(altArrowSequence({type: 'keydown', ctrlKey: true, key: 'ArrowUp'}), null);
  t.is(altArrowSequence({type: 'keydown', ctrlKey: true, key: 'ArrowDown'}), null);
});

test('installed xterm 5.5 bundle rewrites non-Mac Alt+Up/Down to Ctrl+arrow', (t) => {
  const bundlePath = path.join(process.cwd(), 'node_modules/@xterm/xterm/lib/xterm.js');
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  // Minified Keyboard.ts: if (!isMac && key === ESC+"[1;3A") key = ESC+"[1;5A".
  const upRewrite = 'o.key!==s.C0.ESC+"[1;3A"||(o.key=s.C0.ESC+"[1;5A")';
  const downRewrite = 'o.key!==s.C0.ESC+"[1;3B"||(o.key=s.C0.ESC+"[1;5B")';
  t.true(bundle.includes(upRewrite), 'xterm bundle lost the Alt+Up → Ctrl+Up rewrite');
  t.true(bundle.includes(downRewrite), 'xterm bundle lost the Alt+Down → Ctrl+Down rewrite');
  t.is(ALT_UP_SEQUENCE, '\u001b[1;3A');
  t.not(ALT_UP_SEQUENCE, '\u001b[1;5A');
  t.deepEqual(Buffer.from(ALT_UP_SEQUENCE), Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x41]));
  t.deepEqual(Buffer.from(ALT_DOWN_SEQUENCE), Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x42]));
  t.false(bundle.includes(ALT_UP_SEQUENCE));
});
