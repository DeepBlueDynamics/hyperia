// xterm.js 5.5 (the version Hyperia depends on) rewrites a non-Mac Alt+Up
// from CSI modifier 3 (`ESC [1;3A`, Alt) to modifier 5 (`ESC [1;5A`, Ctrl)
// inside its keyboard encoder. Codex's default `edit_queued_message` binding
// is Alt+Up, so the rewritten byte never presses it. Alt+Down is the same
// rewrite and is Codex's `prompt_stack_back` default.
//
// Hyperia keymaps do not bind Alt+Up or Alt+Down. This helper is the single
// place that claims a bare Alt+Up/Down and returns the standard sequence.
// The terminal handler must preventDefault and return false from xterm's
// custom key handler so xterm does not encode a second sequence.

/** CSI: Alt+Up. Parameter 3 is Alt. Not parameter 5 (Ctrl). */
export const ALT_UP_SEQUENCE = '\u001b[1;3A';

/** CSI: Alt+Down. Parameter 3 is Alt. Not parameter 5 (Ctrl). */
export const ALT_DOWN_SEQUENCE = '\u001b[1;3B';

export interface AltArrowKey {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  key?: string;
  /** DOM KeyboardEvent type. Only `keydown` is claimed. `keyup` must not emit. */
  type?: string;
}

/**
 * Bytes to write for a bare Alt+Up or Alt+Down, or null when the event must
 * stay with xterm or with Hyperia's other shortcuts.
 *
 * Claimed: Alt+ArrowUp, Alt+ArrowDown, and the Electron key names `Up` / `Down`
 * with Alt and no Ctrl, Meta, or Shift.
 *
 * Not claimed: Alt+Left/Right (directory history), Ctrl+arrow, Shift+Up/Down
 * (Codex reasoning effort), plain arrows, and any chord that adds another
 * modifier. The same sequence is returned on every platform so macOS cannot
 * double-send (xterm already emits parameter 3 there; the caller suppresses
 * xterm once this returns a sequence).
 */
export function altArrowSequence(event: AltArrowKey): string | null {
  // xterm calls the custom handler for keydown and keyup. Claim keydown only
  // so a keyup is not swallowed and does not write a second sequence.
  // A missing type is treated as keydown for direct callers in tests.
  if (event.type !== undefined && event.type !== 'keydown') {
    return null;
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  const key = event.key;
  if (key === 'ArrowUp' || key === 'Up') {
    return ALT_UP_SEQUENCE;
  }
  if (key === 'ArrowDown' || key === 'Down') {
    return ALT_DOWN_SEQUENCE;
  }
  return null;
}
