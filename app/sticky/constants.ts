import {existsSync} from 'fs';
import {basename, dirname, join} from 'path';

import {app, nativeImage} from 'electron';

import type {StickyColor} from './types';

export function translateContainerPath(filePath: string): string {
  if (process.platform !== 'win32') {
    return filePath;
  }
  if (!filePath) {
    return filePath;
  }

  let normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('file:///')) {
    normalized = normalized.slice(8);
  } else if (normalized.startsWith('file://')) {
    normalized = normalized.slice(7);
  }

  if (normalized.startsWith('workspace/')) {
    normalized = '/' + normalized;
  }

  if (normalized.startsWith('/workspace/')) {
    const parts = normalized.slice(11).split('/');
    const workspaceName = parts[0];
    const relativePath = parts.slice(1).join('\\');

    const currentDir = app ? app.getAppPath() : __dirname;
    let projectRoot = currentDir;

    for (let i = 0; i < 5; i++) {
      if (basename(projectRoot).toLowerCase() === workspaceName.toLowerCase()) {
        return join(projectRoot, relativePath);
      }
      const parent = dirname(projectRoot);
      if (parent === projectRoot) break;
      projectRoot = parent;
    }

    // Fallback using package.json detection
    projectRoot = currentDir;
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(projectRoot, 'package.json'))) {
        return join(projectRoot, relativePath);
      }
      const parent = dirname(projectRoot);
      if (parent === projectRoot) break;
      projectRoot = parent;
    }
  }

  return filePath;
}

export const NOTE_ADJECTIVES = [
  'Bold',
  'Brave',
  'Calm',
  'Clever',
  'Cosmic',
  'Curious',
  'Dapper',
  'Dreamy',
  'Eager',
  'Elegant',
  'Fancy',
  'Fierce',
  'Fluffy',
  'Friendly',
  'Gentle',
  'Glowing',
  'Happy',
  'Honest',
  'Jolly',
  'Kind',
  'Lazy',
  'Lively',
  'Lucky',
  'Mighty',
  'Neat',
  'Noble',
  'Odd',
  'Proud',
  'Quick',
  'Quiet',
  'Relaxed',
  'Royal',
  'Silly',
  'Sleepy',
  'Sly',
  'Smug',
  'Snappy',
  'Spicy',
  'Spotless',
  'Sunny',
  'Swift',
  'Tame',
  'Tidy',
  'Tiny',
  'Wild',
  'Wise',
  'Witty',
  'Zesty',
  'Moody',
  'Furious',
  'Stormy',
  'Creative',
  'Thoughtful',
  'Patient',
  'Sparkly',
  'Drowsy'
];

export const NOTE_ANIMALS = [
  'Badger',
  'Beaver',
  'Bison',
  'Capybara',
  'Cat',
  'Cheetah',
  'Crab',
  'Dolphin',
  'Elephant',
  'Falcon',
  'Ferret',
  'Fox',
  'Frog',
  'Giraffe',
  'Goose',
  'Heron',
  'Hippo',
  'Iguana',
  'Jaguar',
  'Kangaroo',
  'Koala',
  'Lemur',
  'Lion',
  'Llama',
  'Lynx',
  'Manatee',
  'Mole',
  'Moose',
  'Narwhal',
  'Newt',
  'Octopus',
  'Otter',
  'Owl',
  'Panda',
  'Panther',
  'Parrot',
  'Penguin',
  'Platypus',
  'Puma',
  'Quokka',
  'Rabbit',
  'Raccoon',
  'Raven',
  'Seal',
  'Shark',
  'Slug',
  'Sloth',
  'Snail',
  'Squirrel',
  'Stork',
  'Tapir',
  'Tiger',
  'Toucan',
  'Turtle',
  'Vicuna',
  'Walrus',
  'Weasel',
  'Whale',
  'Wolf',
  'Wombat',
  'Yak',
  'Zebra'
];

export const NOTE_EMOJIS = [
  '📝',
  '📌',
  '📋',
  '🗒️',
  '✨',
  '💡',
  '🌟',
  '⭐',
  '🔖',
  '🎯',
  '🔮',
  '🧠',
  '💭',
  '🌙',
  '🪐',
  '🌸',
  '🍀',
  '🌿',
  '🔥',
  '⚡',
  '🦊',
  '🦉',
  '🐸',
  '🦋',
  '🐙',
  '🌊',
  '🍄',
  '🌻',
  '🕯️',
  '🎨'
];

export function noteNameBase(name: string): string {
  return (name || '')
    .replace(/^[^\sA-Za-z0-9]+\s*/, '')
    .trim()
    .toLowerCase();
}

export function generateNoteName(existingNames: string[] = []): string {
  const taken = new Set(existingNames.map((n) => noteNameBase(n)));
  for (let attempt = 0; attempt < 300; attempt++) {
    const adj = NOTE_ADJECTIVES[Math.floor(Math.random() * NOTE_ADJECTIVES.length)];
    const animal = NOTE_ANIMALS[Math.floor(Math.random() * NOTE_ANIMALS.length)];
    const base = `${adj} ${animal}`;
    if (taken.has(base.toLowerCase())) continue;
    if (Math.random() < 1 / 3) {
      const emoji = NOTE_EMOJIS[Math.floor(Math.random() * NOTE_EMOJIS.length)];
      return `${emoji} ${base}`;
    }
    return base;
  }
  const adj = NOTE_ADJECTIVES[Math.floor(Math.random() * NOTE_ADJECTIVES.length)];
  const animal = NOTE_ANIMALS[Math.floor(Math.random() * NOTE_ANIMALS.length)];
  return `${adj} ${animal} ${existingNames.length + 1}`;
}

export const STICKY_COLORS: StickyColor[] = [
  {bg: '#fff9c4', text: '#333', name: 'yellow'},
  {bg: '#c8e6c9', text: '#1b5e20', name: 'green'},
  {bg: '#bbdefb', text: '#0d47a1', name: 'blue'},
  {bg: '#f8bbd0', text: '#880e4f', name: 'pink'},
  {bg: '#e1bee7', text: '#4a148c', name: 'purple'},
  {bg: '#ffe0b2', text: '#e65100', name: 'orange'}
];

let colorIndex = 0;

export function nextColor(): StickyColor {
  const color = STICKY_COLORS[colorIndex % STICKY_COLORS.length];
  colorIndex++;
  return color;
}

export function resetColorIndex(): void {
  colorIndex = 0;
}

export function makeColorSwatch(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const size = 16;

  const rowBytes = Math.ceil((24 * size) / 32) * 4;
  const pixelSize = rowBytes * size;
  const fileSize = 54 + pixelSize;
  const buf = Buffer.alloc(fileSize);

  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);

  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(size, 18);
  buf.writeInt32LE(size, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelSize, 34);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = 54 + y * rowBytes + x * 3;
      buf[offset] = b;
      buf[offset + 1] = g;
      buf[offset + 2] = r;
    }
  }

  return nativeImage.createFromBuffer(buf);
}
