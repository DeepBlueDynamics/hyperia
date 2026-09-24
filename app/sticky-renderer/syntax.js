// highlight.js / agent-highlight for code notes and the text-note backdrop.
'use strict';

const MAX_RULES = 64;
const MAX_PATTERN = 256;
const HLJS_CLASS = /^hljs-[a-z][a-z0-9_-]*$/;
const HEX_COLOR = /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const SAFE_FLAG_CHARS = /^[gimsuy]*$/;

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeClassToken(s) {
  return typeof s === 'string' && HLJS_CLASS.test(s) ? s : '';
}

function safeHexColor(s) {
  return typeof s === 'string' && HEX_COLOR.test(s) ? s : '';
}

function safeFlags(flags) {
  if (flags == null || flags === '') return 'g';
  if (typeof flags !== 'string' || !SAFE_FLAG_CHARS.test(flags)) return null;
  const seen = Object.create(null);
  let out = '';
  for (let i = 0; i < flags.length; i++) {
    const c = flags.charAt(i);
    if (seen[c]) continue;
    seen[c] = true;
    out += c;
  }
  if (!seen.g) out += 'g';
  return out;
}

function applyRules(content, rules) {
  const text = typeof content === 'string' ? content : String(content || '');
  if (!Array.isArray(rules)) return escHtml(text);
  const marks = [];
  const n = Math.min(rules.length, MAX_RULES);
  for (let i = 0; i < n; i++) {
    const rule = rules[i];
    if (!rule || typeof rule.pattern !== 'string') continue;
    if (!rule.pattern || rule.pattern.length > MAX_PATTERN) continue;
    const flags = safeFlags(rule.flags);
    if (!flags) continue;
    try {
      const re = new RegExp(rule.pattern, flags);
      let m;
      let guard = 0;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) break;
        marks.push({
          start: m.index,
          end: m.index + m[0].length,
          className: safeClassToken(rule.className),
          color: safeHexColor(rule.color)
        });
        if (++guard > text.length + 1) break;
      }
    } catch {
      /* invalid regex from agent — skip */
    }
  }
  marks.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const mark of marks) {
    if (mark.start < pos) continue;
    out += escHtml(text.slice(pos, mark.start));
    const cls = mark.className ? ' class="' + mark.className + '"' : '';
    const style = mark.color ? ' style="color:' + mark.color + '"' : '';
    out += '<span' + cls + style + '>' + escHtml(text.slice(mark.start, mark.end)) + '</span>';
    pos = mark.end;
  }
  out += escHtml(text.slice(pos));
  return out;
}

function splitHighlightedLines(html) {
  const out = [];
  const open = [];
  let cur = '';
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) {
        cur += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      cur += tag;
      if (/^<span/i.test(tag)) open.push(tag);
      else if (/^<\/span/i.test(tag)) open.pop();
      i = end + 1;
    } else if (ch === '\n') {
      out.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  out.push(cur);
  return out;
}

function wrapCodeLines(codeEl) {
  const lines = splitHighlightedLines(codeEl.innerHTML);
  codeEl.innerHTML = lines.map((l) => '<span class="line">' + l + '</span>').join('');
}

function createSyntax(ctx) {
  const {doc, persist, win} = ctx;
  const agentCache = new Map();
  ctx.state.highlightMode = ctx.state.highlightMode || 'static';
  ctx.state.syntaxOn = !!ctx.state.syntaxOn;
  let syntaxTimer = null;

  function aiBanner() {
    return doc.getElementById('aiBanner');
  }

  function localHighlight(content, codeEl) {
    delete codeEl.dataset.highlighted;
    codeEl.textContent = content;
    if (win.hljs) win.hljs.highlightElement(codeEl);
  }

  async function loadAgentRules(content) {
    const ipc = ctx.ipc;
    if (!ipc || typeof ipc.invoke !== 'function') return {ok: false};
    const data = await ipc.invoke('sticky-highlight', {content: content.slice(0, 4000)});
    if (!data || data.ok !== true) return {ok: false, error: data && data.error};
    return {ok: true, rules: Array.isArray(data.rules) ? data.rules : []};
  }

  async function runAgentHighlight(content, codeEl) {
    const key = simpleHash(content);
    const banner = aiBanner();
    if (banner) {
      banner.style.display = '';
      banner.className = 'ai-highlight-banner loading';
      banner.innerHTML = '<span class="ai-spinner">↻</span> AI highlighting…';
    }
    let rules;
    if (agentCache.has(key)) {
      rules = agentCache.get(key);
    } else {
      try {
        const result = await loadAgentRules(content);
        if (result.ok === true) {
          rules = result.rules;
          agentCache.set(key, rules);
        } else {
          rules = null;
        }
      } catch (e) {
        rules = null;
      }
    }
    if (rules) {
      codeEl.innerHTML = applyRules(content, rules);
      if (banner) {
        banner.className = 'ai-highlight-banner';
        banner.textContent = `AI highlighted · ${rules.length} rule${rules.length !== 1 ? 's' : ''}`;
      }
    } else {
      if (banner) {
        banner.className = 'ai-highlight-banner';
        banner.textContent = 'AI highlight unavailable — using auto';
      }
      localHighlight(content, codeEl);
    }
  }

  function applyHighlight(content, codeEl) {
    const banner = aiBanner();
    if (ctx.state.highlightMode === 'off') {
      codeEl.textContent = content;
      if (banner) banner.style.display = 'none';
      return undefined;
    }
    if (ctx.state.highlightMode === 'agent') {
      return runAgentHighlight(content, codeEl);
    }
    localHighlight(content, codeEl);
    if (banner) banner.style.display = 'none';
    return undefined;
  }

  function renderSyntax() {
    const ta = doc.getElementById('noteText');
    const bd = doc.getElementById('findHighlights');
    if (!ta || !bd || !win.hljs) return;
    bd.innerHTML = win.hljs.highlightAuto(ta.value).value + '\n';
    bd.scrollTop = ta.scrollTop;
    bd.scrollLeft = ta.scrollLeft;
  }

  function setSyntax(on) {
    ctx.state.syntaxOn = on;
    const ta = doc.getElementById('noteText');
    const bd = doc.getElementById('findHighlights');
    if (!ta || !bd) return;
    if (on) {
      bd.classList.add('syntax');
      if (win.hljs) {
        ta.style.color = 'transparent';
        ta.style.caretColor = win.getComputedStyle(doc.body).color || '#000';
        renderSyntax();
      } else {
        setTimeout(() => {
          if (ctx.state.syntaxOn) setSyntax(true);
        }, 200);
      }
    } else {
      bd.classList.remove('syntax');
      ta.style.color = '';
      ta.style.caretColor = '';
      bd.innerHTML = '';
    }
  }

  function scheduleSyntax() {
    if (!ctx.state.syntaxOn) return;
    clearTimeout(syntaxTimer);
    syntaxTimer = setTimeout(renderSyntax, 150);
  }

  function restoreBackdrop() {
    const bd = doc.getElementById('findHighlights');
    if (!bd) return;
    if (ctx.state.syntaxOn) renderSyntax();
    else bd.innerHTML = '';
  }

  function start() {
    ctx.ipc.on('sticky-set-highlight', (_e, mode) => {
      ctx.state.highlightMode = mode;
      const codeEl = doc.getElementById('codeBlock') && doc.getElementById('codeBlock').querySelector('code');
      if (codeEl) {
        const raw = codeEl.dataset.raw || codeEl.textContent;
        codeEl.dataset.raw = raw;
        applyHighlight(raw, codeEl);
        if (mode !== 'agent') wrapCodeLines(codeEl);
      } else {
        setSyntax(mode !== 'off');
        const note = persist.findNote(ctx.state.noteId) || {id: ctx.state.noteId, name: ctx.state.displayName};
        note.syntax = mode !== 'off';
        note.saved_at = new Date().toISOString();
        persist.saveNote(note);
      }
    });
  }

  return {applyHighlight, wrapCodeLines, setSyntax, scheduleSyntax, restoreBackdrop, renderSyntax, start};
}

module.exports = {
  createSyntax,
  splitHighlightedLines,
  wrapCodeLines,
  applyRules,
  simpleHash,
  escHtml,
  safeClassToken,
  safeHexColor,
  safeFlags,
  MAX_RULES
};
