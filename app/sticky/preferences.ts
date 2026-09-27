import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {homedir} from 'os';
import {join} from 'path';

export function stickysDir(): string {
  const dir = join(homedir(), '.hyperia', 'stickys');
  try {
    mkdirSync(dir, {recursive: true});
  } catch {
    // exists
  }
  return dir;
}

export function stickyStateFile(): string {
  return join(stickysDir(), 'state.json');
}

export function readStickyHidden(): boolean {
  try {
    return JSON.parse(readFileSync(stickyStateFile(), 'utf8'))?.hidden === true;
  } catch {
    return false;
  }
}

export function writeStickyHidden(hidden: boolean): void {
  try {
    writeFileSync(stickyStateFile(), JSON.stringify({hidden}), 'utf8');
  } catch {
    // non-fatal
  }
}

type WorkArea = {width: number; height: number};

// Renderer's built-in stickyFontSize (sticky-renderer/theme.js); sizes below are tuned for it.
const BASE_FONT_SIZE = 22;

// Default window size as a fraction of the display's work area, bounded so it stays
// sane on both small laptops and large monitors. Work areas are in DIPs, so this
// also covers screens where the OS reports a 1.0 scale factor at high resolution.
const DEFAULT_SIZING = {
  text: {fw: 0.25, fh: 0.35, minW: 360, minH: 280, maxW: 560, maxH: 520},
  code: {fw: 0.5, fh: 0.65, minW: 640, minH: 480, maxW: 1100, maxH: 900}
};

function readStickyDefaults(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(join(stickysDir(), 'defaults.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}

function stickyFontSize(d: Record<string, any>): number {
  if (typeof d.fontSize === 'number') return d.fontSize;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.hyperia', 'hyperia.json'), 'utf8'));
    if (typeof cfg?.config?.stickyFontSize === 'number') return cfg.config.stickyFontSize;
  } catch {
    // no config
  }
  return BASE_FONT_SIZE;
}

export function getStickyDefaultSize(
  workArea: WorkArea,
  kind: 'text' | 'code' = 'text'
): {width: number; height: number} {
  const d = readStickyDefaults();
  const s = DEFAULT_SIZING[kind];
  // Bigger font -> proportionally bigger window, so the same amount of content fits.
  const scale = Math.max(0.75, Math.min(2, stickyFontSize(d) / BASE_FONT_SIZE));
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo * scale, Math.min(v, hi * scale)));
  const size = {
    width: clamp(workArea.width * s.fw, s.minW, s.maxW),
    height: clamp(workArea.height * s.fh, s.minH, s.maxH)
  };
  // An explicit width/height in defaults.json still wins for plain notes.
  if (kind === 'text') {
    if (typeof d.width === 'number' && d.width > 0) size.width = d.width;
    if (typeof d.height === 'number' && d.height > 0) size.height = d.height;
  }
  return size;
}

export const STICKY_SEETHROUGH_OPACITY = 0.6;
let stickySeeThrough = false;

export function getStickySeeThrough(): boolean {
  return stickySeeThrough;
}

export function setStickySeeThrough(on: boolean): void {
  stickySeeThrough = on;
}

export function loadStickySeeThrough(): boolean {
  try {
    stickySeeThrough = !!JSON.parse(readFileSync(join(stickysDir(), 'defaults.json'), 'utf8')).seeThrough;
    return stickySeeThrough;
  } catch {
    stickySeeThrough = false;
    return false;
  }
}

export function saveStickySeeThrough(on: boolean): void {
  try {
    const p = join(stickysDir(), 'defaults.json');
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(readFileSync(p, 'utf8')) || {};
    } catch {
      d = {};
    }
    d.seeThrough = on;
    writeFileSync(p, JSON.stringify(d), 'utf8');
  } catch (e) {
    console.error('Failed to save sticky seeThrough:', e);
  }
}

export function stickyOpacityNow(): number {
  return stickySeeThrough ? STICKY_SEETHROUGH_OPACITY : 1.0;
}
