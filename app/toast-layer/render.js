// Toast layer DOM builder. UMD so the page loads it as a plain script (no
// node in the sandboxed layer) and the unit tests require() it. Everything is
// built with textContent — the payload carries agent-supplied names.
(function umd(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HyToastRender = factory();
})(typeof self !== 'undefined' ? self : this, function factory() {
  'use strict';

  // Host CSS variables mirrored into the layer so the toasts match the theme.
  const THEME_VARS = Object.freeze([
    '--bg-elevated',
    '--bg-secondary',
    '--text-primary',
    '--text-secondary',
    '--accent-primary',
    '--accent-success',
    '--accent-danger',
    '--border-neutral',
    '--font-sans'
  ]);

  function applyTheme(doc, theme) {
    const style = doc.documentElement && doc.documentElement.style;
    if (!style || !theme) return;
    for (const name of THEME_VARS) {
      const value = typeof theme[name] === 'string' ? theme[name].trim() : '';
      if (value) style.setProperty(name, value);
      else style.removeProperty(name);
    }
  }

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function buildCard(doc, item, send) {
    const card = el(doc, 'div', 'hy-tl-card');
    card.setAttribute('data-toast-id', item.id);
    const head = el(doc, 'div', 'hy-tl-head');
    head.appendChild(el(doc, 'span', 'hy-tl-emoji', item.emoji || '🤖'));
    const text = el(doc, 'span', 'hy-tl-text');
    if (item.who) text.appendChild(el(doc, 'b', '', item.who));
    text.appendChild(el(doc, 'span', '', (item.who ? ' ' : '') + (item.text || '')));
    head.appendChild(text);
    card.appendChild(head);
    const buttons = Array.isArray(item.buttons) ? item.buttons : [];
    if (buttons.length) {
      const row = el(doc, 'div', 'hy-tl-buttons');
      for (const b of buttons) {
        const style = b.style === 'allow' || b.style === 'deny' ? ' hy-tl-btn-' + b.style : '';
        const btn = el(doc, 'button', 'hy-tl-btn' + style, b.label);
        btn.setAttribute('type', 'button');
        btn.addEventListener('click', () => send(item.id, b.id));
        row.appendChild(btn);
      }
      card.appendChild(row);
    }
    return card;
  }

  function buildPill(doc, item, send) {
    const pill = el(doc, 'div', 'hy-tl-pill');
    pill.setAttribute('data-toast-id', item.id);
    pill.setAttribute('role', 'button');
    pill.title = item.title || 'Click to review';
    pill.appendChild(el(doc, 'span', 'hy-tl-emoji', item.emoji || '🤖'));
    pill.appendChild(el(doc, 'span', '', item.text || ''));
    pill.addEventListener('click', () => send(item.id, 'click'));
    return pill;
  }

  // Bottom-right notice: tone icon, text, optional buttons, optional ×.
  function buildToast(doc, item, send) {
    const toast = el(doc, 'div', 'hy-tl-toast' + (item.tone === 'error' ? ' hy-tl-toast-error' : ''));
    toast.setAttribute('data-toast-id', item.id);
    toast.appendChild(el(doc, 'span', 'hy-tl-toast-icon', item.emoji || (item.tone === 'error' ? '⚠' : '✓')));
    const body = el(doc, 'div', 'hy-tl-toast-body');
    body.appendChild(el(doc, 'div', 'hy-tl-toast-text', item.text || ''));
    const buttons = Array.isArray(item.buttons) ? item.buttons : [];
    if (buttons.length) {
      const row = el(doc, 'div', 'hy-tl-toast-links');
      for (const b of buttons) {
        const btn = el(doc, 'button', 'hy-tl-link', b.label);
        btn.setAttribute('type', 'button');
        btn.addEventListener('click', () => send(item.id, b.id));
        row.appendChild(btn);
      }
      body.appendChild(row);
    }
    toast.appendChild(body);
    if (item.dismissable) {
      const close = el(doc, 'button', 'hy-tl-close', '×');
      close.setAttribute('type', 'button');
      close.setAttribute('aria-label', 'Dismiss');
      close.title = 'Dismiss';
      close.addEventListener('click', () => send(item.id, 'close'));
      toast.appendChild(close);
    }
    return toast;
  }

  function build(doc, item, send) {
    if (item.kind === 'pill') return buildPill(doc, item, send);
    if (item.kind === 'toast') return buildToast(doc, item, send);
    return buildCard(doc, item, send);
  }

  // Sync `root` to `items`. Unchanged items keep their node, so a new toast
  // doesn't replay the entry animation on the ones already up.
  // `send(toastId, buttonId)` is the action sink.
  function render(doc, root, items, send) {
    const all = Array.isArray(items) ? items : [];
    const list = all.filter((i) => i && typeof i.id === 'string');
    const old = new Map();
    for (const node of Array.from(root.children)) old.set(node.getAttribute('data-toast-id'), node);
    const next = list.map((item) => {
      const sig = JSON.stringify(item);
      const prev = old.get(item.id);
      if (prev && prev.__hySig === sig) {
        old.delete(item.id);
        return prev;
      }
      const node = build(doc, item, send);
      node.__hySig = sig;
      return node;
    });
    while (root.firstChild) root.removeChild(root.firstChild);
    for (const node of next) root.appendChild(node);
    return all.length;
  }

  return {THEME_VARS, applyTheme, render};
});
