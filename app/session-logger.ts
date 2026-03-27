// Per-tab session logging — writes raw PTY output to timestamped files.
// Enabled via `sessionLogging: true` in config.
// Logs go to ~/.hyperia/logs/<tab-name>_<timestamp>.log

import {createWriteStream} from 'fs';
import type {WriteStream} from 'fs';
import {mkdirpSync} from 'fs-extra';
import {join} from 'path';

import {cfgDir} from './config/paths';

const logDir = join(cfgDir, 'logs');
const activeLoggers = new Map<string, WriteStream>();

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').substring(0, 60);
}

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

export function startSessionLog(uid: string, tabName: string): void {
  if (activeLoggers.has(uid)) return;

  mkdirpSync(logDir);
  const filename = `${sanitizeFilename(tabName || 'session')}_${timestamp()}.log`;
  const filepath = join(logDir, filename);
  const stream = createWriteStream(filepath, {flags: 'a', encoding: 'utf8'});

  stream.write(`--- Session started: ${new Date().toISOString()} ---\n`);
  stream.write(`--- Tab: ${tabName} | UID: ${uid} ---\n\n`);

  activeLoggers.set(uid, stream);
}

export function writeSessionLog(uid: string, data: string): void {
  const stream = activeLoggers.get(uid);
  if (stream) {
    stream.write(data);
  }
}

export function endSessionLog(uid: string): void {
  const stream = activeLoggers.get(uid);
  if (stream) {
    stream.write(`\n--- Session ended: ${new Date().toISOString()} ---\n`);
    stream.end();
    activeLoggers.delete(uid);
  }
}

export function endAllSessionLogs(): void {
  for (const [uid] of activeLoggers) {
    endSessionLog(uid);
  }
}
