// highlight.js / agent-highlight for code notes and the text-note backdrop.
'use strict';

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function applyRules(content, rules) {
  const marks = [];
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.pattern, rule.flags || 'g');
      let m;
      while ((m = re.exec(content)) !== null) {
        marks.push({
          start: m.index,
          end: m.index + m[0].length,
          className: rule.className || '',
          color: rule.color || ''
        });
        if (m[0].length === 0) re.lastIndex++;
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
    out += escHtml(content.slice(pos, mark.start));
    const style = mark.color ? ` style="color:${mark.color}"` : '';
    out += `<span class="${mark.className}"${style}>${escHtml(content.slice(mark.start, mark.end))}</span>`;
    pos = mark.end;
  }
  out += escHtml(content.slice(pos));
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
        const resp = await fetch('http://localhost:9800/api/notes/highlight', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({content: content.slice(0, 4000)})
        });
        const data = await resp.json();
        rules = data.rules || [];
        agentCache.set(key, rules);
      } catch (e) {
        if (banner) {
          banner.className = 'ai-highlight-banner';
          banner.textContent = 'AI highlight unavailable — using auto';
        }
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
      if (win.hljs) {
        codeEl.textContent = content;
        win.hljs.highlightElement(codeEl);
      }
      if (banner) banner.style.display = 'none';
    }
  }

  function applyHighlight(content, codeEl) {
    const banner = aiBanner();
    if (ctx.state.highlightMode === 'off') {
      codeEl.textContent = content;
      if (banner) banner.style.display = 'none';
    } else if (ctx.state.highlightMode === 'agent') {
      runAgentHighlight(content, codeEl);
    } else {
      codeEl.textContent = content;
      delete codeEl.dataset.highlighted;
      if (win.hljs) win.hljs.highlightElement(codeEl);
      if (banner) banner.style.display = 'none';
    }
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

module.exports = {createSyntax, splitHighlightedLines, wrapCodeLines, applyRules, simpleHash, escHtml};
