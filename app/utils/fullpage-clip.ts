// Pure sizing for the Shift+click full-page web screenshot (CDP captureScreenshot).

// Output height cap in DEVICE pixels — keeps a huge page from blowing memory.
export const FULLPAGE_MAX_DEVICE_PX = 16384;

export interface FullPageClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  truncated: boolean;
}

// Clip (CSS px) covering the whole content, height-capped so height*dpr stays under the cap.
export function fullPageClip(
  content: {width: number; height: number},
  dpr = 1,
  maxDevicePx = FULLPAGE_MAX_DEVICE_PX
): FullPageClip | null {
  const w = Math.ceil(Number(content?.width) || 0);
  const h = Math.ceil(Number(content?.height) || 0);
  if (w <= 0 || h <= 0) return null;
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const maxCss = Math.max(1, Math.floor(maxDevicePx / ratio));
  return {x: 0, y: 0, width: w, height: Math.min(h, maxCss), scale: 1, truncated: h > maxCss};
}
