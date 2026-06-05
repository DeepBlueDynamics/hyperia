export const clickFnStr = `
  (function(searchText) {
    function isVisible(el) {
      if (!el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return true;
    }
    const cleanSearch = searchText.trim().toLowerCase();
    if (!cleanSearch) return { success: false, error: 'Empty search text' };
    const allElements = Array.from(document.querySelectorAll('*'));
    const matches = [];
    for (const el of allElements) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim().toLowerCase();
      if (text.includes(cleanSearch)) {
        matches.push(el);
      }
    }
    if (matches.length === 0) {
      return { success: false, error: 'No elements found containing text: ' + searchText };
    }
    const interactiveTags = ['button', 'a', 'input', 'select', 'textarea', 'option', 'summary'];
    function getScore(el) {
      let score = 0;
      const tagName = el.tagName.toLowerCase();
      if (interactiveTags.includes(tagName)) score += 100;
      if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') score += 100;
      if (el.onclick || el.getAttribute('onclick')) score += 50;
      const textLen = (el.textContent || '').trim().length;
      score -= (textLen - searchText.length) * 0.1;
      score += el.querySelectorAll('*').length === 0 ? 50 : 0;
      return score;
    }
    matches.sort((a, b) => getScore(b) - getScore(a));
    const target = matches[0];
    function triggerMouseEvent(node, eventType) {
      const clickEvent = new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        view: window
      });
      node.dispatchEvent(clickEvent);
    }
    try { target.focus(); } catch(e){}
    triggerMouseEvent(target, 'mouseover');
    triggerMouseEvent(target, 'mousedown');
    triggerMouseEvent(target, 'click');
    triggerMouseEvent(target, 'mouseup');
    if (typeof target.click === 'function') {
      target.click();
    }
    const rect = target.getBoundingClientRect();
    return {
      success: true,
      tagName: target.tagName,
      text: target.textContent ? target.textContent.trim().substring(0, 100) : '',
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    };
  })
`;

// Ghost-cursor mouse driver. Injected into the webview: spawns/moves a 👻 that
// GLIDES to (x, y) so the human can watch the agent move, then (for 'click')
// fires the full pointer/mouse event sequence on the element at that point.
// Returns a Promise so executeJavaScript waits for the glide before clicking.
export const ghostMouseFnStr = `
  (function(x, y, action) {
    return new Promise(function(resolve) {
      try {
        var ID = '__hyperia_ghost__';
        var g = document.getElementById(ID);
        if (!g) {
          g = document.createElement('div');
          g.id = ID;
          g.textContent = '👻';
          g.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;font-size:30px;line-height:1;pointer-events:none;-webkit-user-select:none;transition:transform .42s cubic-bezier(.22,1,.36,1),opacity .3s;filter:drop-shadow(0 3px 5px rgba(0,0,0,.45));will-change:transform;';
          (document.body || document.documentElement).appendChild(g);
        }
        g.style.opacity = '1';
        // Anchor so the ghost's "head" hovers just above the target point.
        g.style.transform = 'translate(' + (x - 8) + 'px,' + (y - 30) + 'px)';

        function finish() {
          if (action !== 'click') {
            resolve({ success: true, action: 'move', x: x, y: y });
            return;
          }
          var el = document.elementFromPoint(x, y);
          try { g.animate([{opacity:1},{opacity:.35},{opacity:1}], {duration:200}); } catch (e) {}
          if (!el) { resolve({ success: false, error: 'No element at (' + x + ',' + y + ')' }); return; }
          var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
          ['pointerover','mouseover','pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t) {
            try { el.dispatchEvent(new MouseEvent(t, opts)); } catch (e) {}
          });
          try { if (typeof el.click === 'function') el.click(); } catch (e) {}
          var label = (el.tagName || '').toLowerCase() + (el.id ? '#' + el.id : '');
          resolve({ success: true, action: 'click', x: x, y: y, target: label, text: (el.textContent || '').trim().slice(0, 80) });
        }
        // Let the glide play out before clicking (purely a nice visual).
        setTimeout(finish, action === 'click' ? 440 : 0);
      } catch (e) {
        resolve({ success: false, error: String(e) });
      }
    });
  })
`;
