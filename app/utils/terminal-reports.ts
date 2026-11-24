// Input that xterm generates by itself rather than from the human typing:
// mouse reports (a program enabled mouse tracking and the pointer moved over
// the pane), focus in/out, cursor-position and device/colour query replies.
// None of it means someone is typing in the pane.

const ESC = '\x1b';

// One report at the start of `s`; returns its length, or 0 if `s` doesn't start with one.
function reportLength(s: string): number {
  if (!s.startsWith(ESC)) return 0;
  // X10 mouse: ESC [ M + three raw bytes.
  if (s.startsWith(`${ESC}[M`) && s.length >= 6) return 6;
  // SGR / urxvt mouse, cursor position, device attributes, focus.
  // eslint-disable-next-line no-control-regex
  const csi = /^\x1b\[(?:<\d+;\d+;\d+[Mm]|\d+;\d+;\d+M|\d+;\d+R|[?>][\d;]*c|I|O)/.exec(s);
  if (csi) return csi[0].length;
  // OSC / DCS replies (colour queries, XTGETTCAP), BEL or ST terminated.
  // eslint-disable-next-line no-control-regex
  const str = /^\x1b[\]P][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(s);
  return str ? str[0].length : 0;
}

/** True when `data` is only terminal-generated reports (and not empty). */
export function isTerminalReport(data: string): boolean {
  if (!data) return false;
  let rest = data;
  while (rest.length) {
    const n = reportLength(rest);
    if (!n) return false;
    rest = rest.slice(n);
  }
  return true;
}
