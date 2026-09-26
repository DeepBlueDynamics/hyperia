import type {IBufferCell, Terminal} from '@xterm/xterm';

// Canvas height cap in device pixels; Chromium canvases fail well past this.
export const SCROLLBACK_MAX_DEVICE_PX = 16384;

// xterm's standard 256-color palette for indices 16..255 (0..15 come from the theme).
export function xterm256(index: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  if (index >= 16 && index < 232) {
    const i = index - 16;
    const lvl = [0, 95, 135, 175, 215, 255];
    return `#${hex(lvl[Math.floor(i / 36)])}${hex(lvl[Math.floor(i / 6) % 6])}${hex(lvl[i % 6])}`;
  }
  if (index >= 232 && index < 256) {
    const v = 8 + (index - 232) * 10;
    return `#${hex(v)}${hex(v)}${hex(v)}`;
  }
  return '#000000';
}

export function rgbToHex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

// Which buffer rows to draw: the NEWEST rows that fit under the device-pixel cap.
export function scrollbackRowRange(
  bufferLength: number,
  rowHeightCss: number,
  dpr = 1,
  maxDevicePx = SCROLLBACK_MAX_DEVICE_PX
): {start: number; end: number; truncated: boolean} {
  const total = Math.max(0, Math.floor(bufferLength));
  const rowDev = Math.max(1, rowHeightCss * (dpr > 0 ? dpr : 1));
  const maxRows = Math.max(1, Math.floor(maxDevicePx / rowDev));
  const start = Math.max(0, total - maxRows);
  return {start, end: total, truncated: start > 0};
}

const THEME_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const;

// Draw the whole xterm buffer (scrollback + screen) to a canvas and return a PNG data URL.
// The live canvas only holds the viewport, so we repaint cells ourselves.
export function renderScrollbackPng(term: Terminal): string | null {
  const buf = term.buffer.active;
  const theme = (term.options.theme || {}) as Record<string, string | undefined>;
  const fg = theme.foreground || '#ffffff';
  const bg = theme.background && theme.background !== 'transparent' ? theme.background : '#000000';
  const palette = (i: number) => (i < 16 ? theme[THEME_KEYS[i]] || xterm256(i) : xterm256(i));

  const fontSize = term.options.fontSize || 12;
  const fontFamily = term.options.fontFamily || 'monospace';
  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
  const rect = screen?.getBoundingClientRect();
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  probe.font = `${fontSize}px ${fontFamily}`;
  // Match the rendered cell grid when we can; fall back to font metrics.
  const cellW = rect && rect.width > 0 ? rect.width / term.cols : probe.measureText('W').width;
  const cellH = rect && rect.height > 0 ? rect.height / term.rows : Math.ceil(fontSize * 1.2);

  const dpr = window.devicePixelRatio || 1;
  const {start, end} = scrollbackRowRange(buf.length, cellH, dpr);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(term.cols * cellW * dpr);
  canvas.height = Math.ceil((end - start) * cellH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, term.cols * cellW, (end - start) * cellH);
  ctx.textBaseline = 'middle';

  const colorOf = (cell: IBufferCell, which: 'fg' | 'bg'): string | null => {
    const isRGB = which === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
    const isPal = which === 'fg' ? cell.isFgPalette() : cell.isBgPalette();
    const v = which === 'fg' ? cell.getFgColor() : cell.getBgColor();
    if (isRGB) return rgbToHex(v);
    if (isPal) return palette(v);
    return null;
  };

  let cell: IBufferCell | undefined = buf.getNullCell();
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const py = (y - start) * cellH;
    for (let x = 0; x < term.cols; x++) {
      cell = line.getCell(x, cell);
      if (!cell || cell.getWidth() === 0) continue;
      let cfg = colorOf(cell, 'fg') || fg;
      let cbg = colorOf(cell, 'bg');
      if (cell.isInverse()) {
        const t = cbg || bg;
        cbg = cfg;
        cfg = t;
      }
      const w = cellW * cell.getWidth();
      if (cbg) {
        ctx.fillStyle = cbg;
        ctx.fillRect(x * cellW, py, w, cellH);
      }
      const ch = cell.getChars();
      if (!ch || ch === ' ' || cell.isInvisible()) continue;
      ctx.font = `${cell.isItalic() ? 'italic ' : ''}${cell.isBold() ? 'bold ' : ''}${fontSize}px ${fontFamily}`;
      ctx.globalAlpha = cell.isDim() ? 0.5 : 1;
      ctx.fillStyle = cfg;
      ctx.fillText(ch, x * cellW, py + cellH / 2);
    }
  }
  ctx.globalAlpha = 1;
  return canvas.toDataURL('image/png');
}
