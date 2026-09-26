// Inline URL / note-ref tokens. Ctrl/Cmd+click follows; toast is self-contained.
'use strict';

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const NOTE_FROM_RE = /\[From:\s*([^\]]+)\]/g;
const NOTE_URL_RE = /app:\/\/sticky\/([^\s"'<>)\]]+)/g;
const WIKI_RE = /\[\[([^[\]\n]+?)\]\]/g;
const STICKY_ID_RE = /(?<![\w/:])sticky:([A-Za-z0-9][\w.-]*[A-Za-z0-9]|[A-Za-z0-9])/g;

// Sentence punctuation after a bare URL belongs to the sentence, not the URL.
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

const PATTERNS = [
  {re: URL_RE, kind: 'url', cap: 0, trim: true},
  {re: NOTE_URL_RE, kind: 'note', cap: 1, trim: true},
  {re: WIKI_RE, kind: 'note', cap: 1},
  {re: STICKY_ID_RE, kind: 'note', cap: 1},
  {re: NOTE_FROM_RE, kind: 'note', cap: 1}
];

// Every link token in text, sorted and non-overlapping: {start, end, kind, value}.
function findLinks(text) {
  const found = [];
  const s = String(text || '');
  for (const {re, kind, cap, trim} of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      let raw = m[0];
      let value = cap ? m[cap] : m[0];
      if (trim) {
        const cut = (TRAILING_PUNCT_RE.exec(raw) || [''])[0].length;
        raw = raw.slice(0, raw.length - cut);
        if (!cap) value = raw;
        else if (cut) value = value.slice(0, value.length - cut);
      }
      value = value.trim();
      if (value) found.push({start: m.index, end: m.index + raw.length, kind, value});
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let end = -1;
  for (const tok of found) {
    if (tok.start >= end) {
      out.push(tok);
      end = tok.end;
    }
  }
  return out;
}

// A Markdown link target → {kind, value}, or null for anything we won't open.
function classifyHref(href) {
  const h = String(href || '').trim();
  if (/^https?:\/\/[^\s"'<>]+$/i.test(h)) return {kind: 'url', value: h};
  let m = /^sticky:(.+)$/i.exec(h);
  if (m) return {kind: 'note', value: decodeSafe(m[1])};
  m = /^app:\/\/sticky\/(.+)$/i.exec(h);
  if (m) return {kind: 'note', value: decodeSafe(m[1])};
  m = /^\[\[(.+)\]\]$/.exec(h);
  if (m) return {kind: 'note', value: m[1].trim()};
  return null;
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s).trim();
  } catch (e) {
    return s.trim();
  }
}

function linkTokenAt(text, pos) {
  for (const tok of findLinks(text)) {
    if (pos >= tok.start && pos <= tok.end) return {kind: tok.kind, value: tok.value};
  }
  return null;
}

function allLinkRanges(text) {
  return findLinks(text).map((t) => [t.start, t.end]);
}

// Route a token to main: URLs via the external-open IPC, notes by id or name.
function openLink(ipc, tok) {
  if (!tok || !tok.value) return false;
  if (tok.kind === 'url') {
    if (!/^https?:\/\//i.test(tok.value)) return false;
    ipc.send('sticky-open-external', tok.value);
  } else if (tok.kind === 'note') {
    ipc.send('sticky-open-note', tok.value);
  } else return false;
  return true;
}

function followLinkInTextarea(textarea, ipc) {
  return openLink(ipc, linkTokenAt(textarea.value, textarea.selectionStart));
}

// Rendered Markdown links (a.md-link) open on click without focusing or selecting.
function bindRenderedLinks(el, ipc) {
  if (!el) return;
  const hit = (e) => e.target && e.target.closest && e.target.closest('a.md-link');
  el.addEventListener('mousedown', (e) => {
    if (hit(e)) e.preventDefault();
  });
  el.addEventListener('click', (e) => {
    const a = hit(e);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    openLink(ipc, {kind: a.getAttribute('data-kind'), value: a.getAttribute('data-target')});
  });
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
  for (const tok of findLinks(text)) {
    if (tok.kind === 'url' && pos >= tok.start && pos <= tok.end) return [tok.start, tok.end];
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
  findLinks,
  classifyHref,
  linkTokenAt,
  allLinkRanges,
  openLink,
  followLinkInTextarea,
  bindRenderedLinks,
  showToast,
  linkRangeAt,
  start
};
