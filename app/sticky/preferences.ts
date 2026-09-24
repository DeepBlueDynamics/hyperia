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

export function getStickyDefaultSize(): {width: number; height: number} {
  try {
    const d = JSON.parse(readFileSync(join(stickysDir(), 'defaults.json'), 'utf8'));
    return {width: d.width || 280, height: d.height || 220};
  } catch {
    return {width: 280, height: 220};
  }
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
