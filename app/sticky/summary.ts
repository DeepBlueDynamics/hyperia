import {SEARCH_WIN_ID, stickyWindows} from './registry';
import {readAllNotes} from './store';
import type {NoteData} from './types';

export function buildStickysSummary(): string {
  const all = readAllNotes().filter((n) => n.text && n.text.trim().length > 0);
  const openIds = new Set([...stickyWindows.keys()].filter((id) => id !== SEARCH_WIN_ID));
  const recency = (n: NoteData) => Date.parse(n.last_closed_at || '') || Date.parse(n.saved_at || '') || 0;
  const active = all.filter((n) => openIds.has(n.id)).sort((a, b) => recency(b) - recency(a));
  const saved = all.filter((n) => !openIds.has(n.id)).sort((a, b) => recency(b) - recency(a));

  const now = new Date();
  const ts =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')} ${now.toTimeString().slice(0, 8)}`;
  const bar = '─'.repeat(38);
  const padRow = (s: string) => '│ ' + s + ' '.repeat(Math.max(0, bar.length - 1 - s.length)) + '│';
  const title = 'Stickys Summary';
  const tp = Math.floor((bar.length - title.length) / 2);
  const preview = (n: NoteData) => (n.text || '').replace(/\s+/g, ' ').slice(0, 80);

  const lines: string[] = [
    '┌' + bar + '┐',
    '│' + ' '.repeat(tp) + title + ' '.repeat(bar.length - tp - title.length) + '│',
    '├' + bar + '┤',
    padRow('Generated: ' + ts),
    padRow(`Active: ${active.length}   Saved: ${saved.length}`),
    '└' + bar + '┘',
    ''
  ];
  if (active.length) {
    lines.push(`🟢 ACTIVE STICKYS (${active.length}):`);
    for (const n of active) lines.push(`- [From: ${n.name || n.id}] — ${preview(n)}`);
    lines.push('');
  }
  if (saved.length) {
    lines.push(`💾 SAVED STICKYS (${saved.length}):`);
    for (const n of saved.slice(0, 20)) lines.push(`- [From: ${n.name || n.id}] — ${preview(n)}`);
    if (saved.length > 20) lines.push(`… and ${saved.length - 20} more saved stickys`);
    lines.push('');
  }
  lines.push('💡 Ctrl/Cmd+click a [From: name] link to open that sticky.');
  return lines.join('\n');
}
