import test from 'ava';

import {FULLPAGE_MAX_DEVICE_PX, fullPageClip} from '../../app/utils/fullpage-clip';
import {rgbToHex, scrollbackRowRange, xterm256} from '../../lib/utils/scrollback-shot';

test('fullPageClip covers a short page whole', (t) => {
  t.deepEqual(fullPageClip({width: 1280, height: 3000.4}, 1), {
    x: 0,
    y: 0,
    width: 1280,
    height: 3001,
    scale: 1,
    truncated: false
  });
});

test('fullPageClip caps height in device pixels', (t) => {
  const c1 = fullPageClip({width: 1000, height: 100000}, 1);
  t.is(c1?.height, FULLPAGE_MAX_DEVICE_PX);
  t.true(c1?.truncated);
  const c2 = fullPageClip({width: 1000, height: 100000}, 2);
  t.is(c2?.height, FULLPAGE_MAX_DEVICE_PX / 2);
  const c3 = fullPageClip({width: 1000, height: 100000}, 1.5, 1000);
  t.is(c3?.height, 666);
});

test('fullPageClip rejects empty or bogus sizes and bad dpr', (t) => {
  t.is(fullPageClip({width: 0, height: 500}), null);
  t.is(fullPageClip({width: 500, height: NaN}), null);
  t.is(fullPageClip(undefined as any), null);
  t.is(fullPageClip({width: 10, height: 20000}, 0)?.height, FULLPAGE_MAX_DEVICE_PX);
});

test('scrollbackRowRange keeps the newest rows under the cap', (t) => {
  t.deepEqual(scrollbackRowRange(100, 17, 1), {start: 0, end: 100, truncated: false});
  // 16384 / (16 * 2) = 512 rows fit
  t.deepEqual(scrollbackRowRange(10000, 16, 2), {start: 9488, end: 10000, truncated: true});
  t.deepEqual(scrollbackRowRange(0, 16, 1), {start: 0, end: 0, truncated: false});
});

test('xterm256 matches the standard cube and gray ramp', (t) => {
  t.is(xterm256(16), '#000000');
  t.is(xterm256(21), '#0000ff');
  t.is(xterm256(196), '#ff0000');
  t.is(xterm256(231), '#ffffff');
  t.is(xterm256(232), '#080808');
  t.is(xterm256(255), '#eeeeee');
});

test('rgbToHex pads and masks', (t) => {
  t.is(rgbToHex(0x00ff00), '#00ff00');
  t.is(rgbToHex(0x1), '#000001');
});
