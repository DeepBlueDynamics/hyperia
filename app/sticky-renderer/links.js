// Inline URL / note-ref tokens. Ctrl/Cmd+click follows; toast is self-contained.
'use strict';

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const NOTE_FROM_RE = /\[From:\s*([^\]]+)\]/g;
const NOTE_URL_RE = /app:\/\/sticky\/([^\s"'<>)\]]+)/g;

function linkTokenAt(text, pos) {
  const tries = [
    {re: URL_RE, kind: 'url', cap: 0},
    {re: NOTE_URL_RE, kind: 'note', cap: 1},
    {re: NOTE_FROM_RE, kind: 'note', cap: 1}
  ];
  for (const {re, kind, cap} of tries) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const from = m.index,
        to = from + m[0].length;
      if (pos >= from && pos <= to) {
        return {kind, value: (cap ? m[cap] : m[0]).trim()};
      }
    }
  }
  return null;
}

function allLinkRanges(text) {
  const ranges = [];
  for (const re of [URL_RE, NOTE_FROM_RE, NOTE_URL_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

function followLinkInTextarea(textarea, ipc) {
  const tok = linkTokenAt(textarea.value, textarea.selectionStart);
  if (!tok) return false;
  if (tok.kind === 'url') ipc.send('sticky-open-external', tok.value);
  else ipc.send('sticky-open-note', tok.value);
  return true;
}

function showToast(doc, msg) {
  let el = doc.getElementById('stickyToast');
  if (!el) {
    el = doc.createElement('div');
    el.id = 'stickyToast';
    el.style.cssText =
      'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);' +
      'background:rgba(18,18,22,.94);color:#e8e8ea;font:12px/1.4 -apple-system,system-ui,sans-serif;' +
      'padding:7px 12px;border-radius:7px;box-shadow:0 4px 16px rgba(0,0,0,.45);' +
      'z-index:99999;pointer-events:none;opacity:0;transition:opacity .14s ease;max-width:90vw;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    doc.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  if (showToast._timer) clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.style.opacity = '0';
  }, 1700);
}

function linkRangeAt(text, pos) {
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    const s = m.index,
      e = s + m[0].length;
    if (pos >= s && pos <= e) return [s, e];
  }
  return null;
}

function start(ctx) {
  const {ipc, doc} = ctx;
  ipc.on('sticky-toast', (_e, msg) => showToast(doc, String(msg || '')));
  ipc.on('sticky-edit-link', () => {
    const ta = doc.getElementById('noteText');
    if (!ta) return;
    const r = linkRangeAt(ta.value, ta.selectionStart);
    ta.focus();
    if (r) ta.setSelectionRange(r[0], r[1]);
  });
}

module.exports = {
  URL_RE,
  linkTokenAt,
  allLinkRanges,
  followLinkInTextarea,
  showToast,
  linkRangeAt,
  start
};
