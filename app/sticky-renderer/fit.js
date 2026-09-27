// One-shot "fit to content" for brand-new notes (#280). Main opts a note in by
// passing fit=maxW,maxH,minW,minH (window px) on the URL; we measure the
// rendered content once and ask main for a window size that shows all of it.
'use strict';

// Extra px so a fit that rounds a hair short doesn't leave a scrollbar.
const SLACK = 8;

function parseFitParam(value) {
  if (!value) return null;
  const n = String(value).split(',').map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v) || v <= 0)) return null;
  return {maxW: n[0], maxH: n[1], minW: n[2], minH: n[3]};
}

const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(v, hi)));

// Pure sizing math. `naturalW` is the content's unwrapped width (padding
// included); `heightAt(w)` returns the content height when laid out at content
// width `w`; chromeW/H is everything in the window that isn't the content box.
function planFit({naturalW, heightAt, chromeW, chromeH, caps}) {
  const width = clamp(naturalW + chromeW + SLACK, caps.minW, caps.maxW);
  const height = clamp(heightAt(width - chromeW) + chromeH + SLACK, caps.minH, caps.maxH);
  return {width, height};
}

// Off-screen copy of `el` laid out like it (same classes/fonts/padding) but
// free to size itself, so we can read the content's natural dimensions.
function makeProbe(doc, el) {
  let probe;
  if (el.tagName === 'TEXTAREA') {
    probe = doc.createElement('div');
    probe.className = el.className;
    probe.textContent = el.value + '\n';
  } else {
    probe = el.cloneNode(true);
    probe.removeAttribute('id');
  }
  Object.assign(probe.style, {
    position: 'absolute',
    inset: 'auto',
    left: '-100000px',
    top: '0',
    visibility: 'hidden',
    height: 'auto',
    maxHeight: 'none',
    overflow: 'visible',
    flex: 'none',
    boxSizing: 'border-box'
  });
  el.parentNode.appendChild(probe);
  return probe;
}

// Measure `el`'s content and plan the window size that shows all of it.
function fitSize(doc, win, el, caps) {
  const probe = makeProbe(doc, el);
  try {
    probe.style.whiteSpace = 'pre';
    probe.style.width = 'max-content';
    const naturalW = probe.scrollWidth;
    probe.style.whiteSpace = '';
    return planFit({
      naturalW,
      heightAt: (w) => {
        probe.style.width = w + 'px';
        return probe.scrollHeight;
      },
      // Sticky windows are frameless, so inner size == window size.
      chromeW: win.innerWidth - el.clientWidth,
      chromeH: win.innerHeight - el.clientHeight,
      caps
    });
  } finally {
    probe.remove();
  }
}

// A timer, not requestAnimationFrame: rAF never fires in an occluded window,
// and reading scroll sizes forces layout anyway.
const settle = (win) => new Promise((r) => win.setTimeout(r, 50));

// Wait for fonts + layout, measure, and send one request. Never throws.
async function start(ctx, caps) {
  const {doc, win, ipc} = ctx;
  try {
    if (doc.fonts && doc.fonts.ready) await doc.fonts.ready;
    await settle(win);
    const el = doc.getElementById('noteText') || doc.getElementById('codeBlock');
    if (!el || !el.parentNode) return;
    const size = fitSize(doc, win, el, caps);
    ipc.send('sticky-fit', ctx.state.noteId, size);
  } catch (e) {
    console.error('sticky fit failed:', e);
  }
}

module.exports = {parseFitParam, planFit, start, SLACK};
