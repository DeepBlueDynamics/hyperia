// Small, safe Markdown → HTML for sticky results. Everything is escaped; the
// only tags emitted are the ones built here, and links carry no href.
'use strict';

const links = require('./links');

const ESC = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

// Placeholders use NUL, which is stripped from input first so it can't be forged.
const PH = '\u0000';

function anchor(kind, target, labelHtml) {
  return `<a class="md-link" data-kind="${kind}" data-target="${escapeHtml(target)}" title="${escapeHtml(
    target
  )}">${labelHtml}</a>`;
}

function renderInline(text) {
  const slots = [];
  return restore(inline(String(text).split(PH).join(''), true, slots), slots, 0);
}

// Odd split parts are slot indexes; slots may nest (a code span inside a link label).
function restore(s, slots, depth) {
  if (!s.includes(PH) || depth > 3) return s;
  return s
    .split(PH)
    .map((part, i) => (i % 2 ? restore(slots[Number(part)] || '', slots, depth + 1) : part))
    .join('');
}

function inline(src, allowLinks, slots) {
  const hold = (html) => `${PH}${slots.push(html) - 1}${PH}`;
  let s = src;
  if (allowLinks) {
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code) =>
      hold(`<code>${escapeHtml(code.trim())}</code>`)
    );
    s = s.replace(/\[([^[\]\n]+)\]\(\s*([^()\s]+)\s*\)/g, (m, label, href) => {
      const tok = links.classifyHref(href);
      return tok ? hold(anchor(tok.kind, tok.value, inline(label, false, slots))) : m;
    });
    const found = links.findLinks(s);
    let out = '';
    let pos = 0;
    for (const tok of found) {
      out += s.slice(pos, tok.start);
      out += hold(anchor(tok.kind, tok.value, escapeHtml(s.slice(tok.start, tok.end))));
      pos = tok.end;
    }
    s = out + s.slice(pos);
  }

  s = escapeHtml(s);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?=[^\w]|$)/g, '$1<strong>$2</strong>');
  s = s.replace(/\*(?=[^\s*])([^*]*?[^\s*])?\*/g, (m, inner) => (inner === undefined ? m : `<em>${inner}</em>`));
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])?_(?=[^\w]|$)/g, (m, pre, inner) =>
    inner === undefined ? m : `${pre}<em>${inner}</em>`
  );
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  return s;
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isBlockStart(lines, i) {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    LIST_RE.test(line) ||
    QUOTE_RE.test(line) ||
    (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-'))
  );
}

function indentOf(s) {
  return s.replace(/\t/g, '  ').match(/^ */)[0].length;
}

function parseList(lines, start) {
  const first = LIST_RE.exec(lines[start]);
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    const m = LIST_RE.exec(line);
    const ind = indentOf(line);
    if (m && ind === base && /\d/.test(m[2]) === ordered) {
      items.push({text: m[3], children: ''});
      i++;
    } else if (m && ind > base && items.length) {
      const sub = parseList(lines, i);
      items[items.length - 1].children += sub.html;
      i = sub.next;
    } else if (!m && ind > base && items.length) {
      items[items.length - 1].text += ' ' + line.trim();
      i++;
    } else break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const n = ordered ? parseInt(first[2], 10) : 1;
  const startAttr = ordered && n !== 1 ? ` start="${n}"` : '';
  const body = items
    .map((it) => {
      const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
      const inner = task
        ? `<span class="md-task">${task[1] === ' ' ? '☐' : '☑'}</span> ${renderInline(task[2])}`
        : renderInline(it.text);
      return `<li>${inner}${it.children}</li>`;
    })
    .join('');
  return {html: `<${tag}${startAttr}>${body}</${tag}>`, next: i};
}

function renderBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      const n = h[1].length;
      out.push(`<h${n}>${renderInline(h[2])}</h${n}>`);
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''
      );
      const cell = (tag, c, k) => {
        const a = aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
        return `<${tag}${a}>${renderInline(c)}</${tag}>`;
      };
      let html = `<table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = splitRow(lines[i++]);
        html += `<tr>${head.map((_h, k) => cell('td', row[k] || '', k)).join('')}</tr>`;
      }
      out.push(html + '</tbody></table>');
      continue;
    }
    if (LIST_RE.test(line)) {
      const list = parseList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) inner.push(QUOTE_RE.exec(lines[i++])[1]);
      out.push(`<blockquote>${renderBlocks(inner)}</blockquote>`);
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) para.push(lines[i++].trim());
    // Sticky results are line-oriented, so single newlines stay line breaks.
    out.push(`<p>${para.map((p) => renderInline(p)).join('<br>')}</p>`);
  }
  return out.join('');
}

function renderMarkdown(src) {
  if (src === null || src === undefined) return '';
  return renderBlocks(String(src).replace(/\r\n?/g, '\n').split('\n'));
}

module.exports = {renderMarkdown, renderInline, escapeHtml};
