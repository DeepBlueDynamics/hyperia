// Run history: ~/.hyperia/stickys/runs.jsonl, one RunRecord per line, trimmed per note.
import {appendFileSync, readFileSync, renameSync, writeFileSync} from 'fs';
import {join} from 'path';

import {stickysDir} from '../preferences';
import type {RunRecord} from '../types';

export function runsFile(): string {
  return join(stickysDir(), 'runs.jsonl');
}

function readLines(): RunRecord[] {
  let raw = '';
  try {
    raw = readFileSync(runsFile(), 'utf8');
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.note === 'string') out.push(rec as RunRecord);
    } catch {
      // A torn final line from a crash is skipped, not fatal.
    }
  }
  return out;
}

/** Newest first. */
export function readHistory(noteId: string, limit = 50): RunRecord[] {
  return readLines()
    .filter((r) => r.note === noteId)
    .sort((a, b) => b.finished - a.finished)
    .slice(0, Math.max(0, limit));
}

/** Append one finished run, then keep only the newest `limit` records for that note. */
export function appendHistory(rec: RunRecord, limit: number): void {
  try {
    appendFileSync(runsFile(), JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    console.error('[sticky] failed to append run history:', e);
    return;
  }
  const all = readLines();
  const mine = all.filter((r) => r.note === rec.note);
  if (mine.length <= limit) return;
  const drop = new Set(mine.sort((a, b) => b.finished - a.finished).slice(limit));
  const kept = all.filter((r) => !drop.has(r));
  try {
    const tmp = `${runsFile()}.tmp.${process.pid}`;
    writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    renameSync(tmp, runsFile());
  } catch (e) {
    console.error('[sticky] failed to trim run history:', e);
  }
}
