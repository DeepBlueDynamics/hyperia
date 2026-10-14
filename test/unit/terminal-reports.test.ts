import test from 'ava';

import {isTerminalReport} from '../../app/utils/terminal-reports';

test('mouse, focus and query replies are not typing', (t) => {
  for (const s of [
    '\x1b[<35;80;12M', // SGR motion
    '\x1b[<64;10;5M\x1b[<64;10;5M', // wheel, batched
    '\x1b[<0;3;4m', // SGR release
    '\x1b[M #!', // X10
    '\x1b[32;10;5M', // urxvt
    '\x1b[I',
    '\x1b[O',
    '\x1b[12;40R', // cursor position
    '\x1b[?1;2c', // DA1
    '\x1b[>0;276;0c', // DA2
    '\x1b]11;rgb:1c1c/1c1c/2222\x07', // OSC 11 reply
    '\x1b]10;rgb:e8e8/e8e8/eaea\x1b\\'
  ]) {
    t.true(isTerminalReport(s), JSON.stringify(s));
  }
});

test('keys the human types are typing', (t) => {
  for (const s of [
    'a',
    'hello',
    '\r',
    '\x03',
    '\x1b',
    '\x1b[A',
    '\x1b[3~',
    '\x1bOP',
    '\x1b[200~paste\x1b[201~',
    '\x1b[<35;80;12Mx',
    ''
  ]) {
    t.false(isTerminalReport(s), JSON.stringify(s));
  }
});
