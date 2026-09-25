// Ctrl+^ is ASCII RS (0x1E): nemesis8's detach key ("press Ctrl+^ to detach").
// xterm.js 5.5 maps Ctrl+6 to 0x1E only when Shift is NOT held; Ctrl+Shift+6
// (how ^ is actually typed on US layouts) falls through and sends nothing.
// This helper claims that chord; the terminal handler writes the byte and
// returns false so xterm does not encode anything else.

export const CTRL_CARET = '\u001e';

export interface CaretKey {
  type?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  key?: string;
  code?: string;
}

/** 0x1E for a Ctrl+^ keydown (Ctrl+Shift+6, or any layout whose key is '^'); else null. */
export function ctrlCaretSequence(e: CaretKey): string | null {
  if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === '^') return CTRL_CARET;
  if (e.shiftKey && e.code === 'Digit6') return CTRL_CARET;
  return null;
}
