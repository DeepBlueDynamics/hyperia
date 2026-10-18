// Copy a 4-byte-per-pixel bitmap into a larger one at (x, y), clipped to the
// destination. Used to paint web-pane captures onto a window capture.
export function blitBitmap(
  dst: Buffer,
  dstW: number,
  dstH: number,
  src: Buffer,
  srcW: number,
  srcH: number,
  x: number,
  y: number
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(dstW, x + srcW);
  const y1 = Math.min(dstH, y + srcH);
  if (x1 <= x0 || y1 <= y0) return;
  const rowBytes = (x1 - x0) * 4;
  for (let dy = y0; dy < y1; dy++) {
    const s = ((dy - y) * srcW + (x0 - x)) * 4;
    src.copy(dst, (dy * dstW + x0) * 4, s, s + rowBytes);
  }
}
