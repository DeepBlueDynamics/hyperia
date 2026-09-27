import {readdirSync, readFileSync} from 'fs';
import {join} from 'path';

import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {defaultTimers} = require('../../app/sticky-renderer/timers');

// In the renderer, setTimeout & co. are window methods that throw "Illegal
// invocation" when called with any receiver but window. Node's don't care, so
// emulate the browser's rule to catch `timers.setInterval(...)` on a plain object.
const NAMES = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;

test.serial('defaultTimers never invokes the globals with a foreign `this`', (t) => {
  const g = globalThis as any;
  const originals = NAMES.map((n) => g[n]);
  const calls: string[] = [];
  NAMES.forEach((n) => {
    g[n] = function browserTimer(this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(n);
      return 1;
    };
  });
  try {
    const timers = defaultTimers();
    timers.setTimeout(() => {}, 1);
    timers.clearTimeout(1);
    timers.setInterval(() => {}, 1);
    timers.clearInterval(1);
    t.deepEqual(calls, [...NAMES]);

    // The shape that broke v0.21: shorthand object of the globals.
    const bad = {setInterval: g.setInterval};
    t.throws(() => bad.setInterval(() => {}, 1), {message: 'Illegal invocation'});
  } finally {
    NAMES.forEach((n, i) => (g[n] = originals[i]));
  }
});

test('no sticky renderer module builds a timer object from bare globals', (t) => {
  const dir = join(__dirname, '../../app/sticky-renderer');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    t.notRegex(src, /\{\s*setTimeout\s*,\s*clearTimeout/, `${f} passes window timers as object methods`);
  }
});
