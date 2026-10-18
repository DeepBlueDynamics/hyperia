import test from 'ava';

import {blitBitmap} from '../../app/utils/bitmap-blit';

// One byte value per pixel, repeated 4x, so pixels are easy to read back.
const bmp = (w: number, h: number, fill: number) => Buffer.alloc(w * h * 4, fill);
const px = (b: Buffer, w: number, x: number, y: number) => b[(y * w + x) * 4];

test('blitBitmap copies inside the destination', (t) => {
  const dst = bmp(4, 4, 0);
  blitBitmap(dst, 4, 4, bmp(2, 2, 9), 2, 2, 1, 1);
  t.is(px(dst, 4, 0, 0), 0);
  t.is(px(dst, 4, 1, 1), 9);
  t.is(px(dst, 4, 2, 2), 9);
  t.is(px(dst, 4, 3, 3), 0);
});

test('blitBitmap clips at every edge', (t) => {
  const dst = bmp(3, 3, 0);
  blitBitmap(dst, 3, 3, bmp(5, 5, 7), 5, 5, -1, -1);
  t.true(dst.every((v) => v === 7));
  const dst2 = bmp(3, 3, 0);
  blitBitmap(dst2, 3, 3, bmp(2, 2, 5), 2, 2, 2, 2);
  t.is(px(dst2, 3, 2, 2), 5);
  t.is(px(dst2, 3, 1, 1), 0);
});

test('blitBitmap ignores a source fully off the destination', (t) => {
  const dst = bmp(2, 2, 1);
  blitBitmap(dst, 2, 2, bmp(2, 2, 8), 2, 2, 5, 0);
  blitBitmap(dst, 2, 2, bmp(2, 2, 8), 2, 2, -3, 0);
  t.true(dst.every((v) => v === 1));
});
