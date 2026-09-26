// The text handed to an agent or pane for a run (CONTRACT: "Prompt handed to an agent").
import type {NoteData, RunRecord} from '../types';

export function buildAgentPrompt(note: NoteData, history: RunRecord[] = []): string {
  const name = note.name || note.id;
  const lines = [
    `You're working on Hyperia sticky \`${note.id}\` "${name}". Read it with sticky_note_read.`,
    'If you have a result, write it with sticky_note_update {id, result} (it replaces the previous result; keep it concise, Markdown ok).',
    `Task: ${(note.text || '').trim()}`
  ];
  const keep = note.run?.history?.keep;
  const past = history.filter((r) => typeof r.result === 'string' && r.result.trim());
  if (keep && past.length) {
    lines.push('Previous results (newest first):');
    for (const r of [...past].sort((a, b) => b.finished - a.finished)) {
      lines.push(`- ${new Date(r.finished).toISOString()}: ${(r.result as string).trim()}`);
    }
  }
  return lines.join('\n');
}

export function buildPanePrompt(note: NoteData, history: RunRecord[] = []): string {
  return `Sticky "${note.name || note.id}" (${note.id}): ${buildAgentPrompt(note, history)}`;
}
