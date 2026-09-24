// Chromium scrolls a focused input back into view when layout changes (e.g.
// resizing a short pane that holds the picker), and it scrolls EVERY ancestor
// to do it — overflow:hidden layout containers included. That shoved the whole
// window up and hid the header/tab bar. Containers that clip (overflow-y
// hidden/clip) are never meant to scroll, so any vertical scroll they pick up is
// undone. Real scroll areas (xterm viewport, picker lists) use auto/scroll and
// are left alone; horizontal scroll (the tab strip) is never touched.

export function clipsVertically(overflowY: string): boolean {
  return overflowY === 'hidden' || overflowY === 'clip';
}

export function installLayoutScrollPin(doc: Document = document): () => void {
  const onScroll = (e: Event) => {
    const target = e.target;
    if (target === doc || target === doc.documentElement || target === doc.body) {
      const root = doc.scrollingElement;
      if (root && root.scrollTop !== 0) root.scrollTop = 0;
      return;
    }
    if (!(target instanceof HTMLElement) || target.scrollTop === 0) return;
    const view = doc.defaultView;
    if (view && clipsVertically(view.getComputedStyle(target).overflowY)) target.scrollTop = 0;
  };
  // scroll doesn't bubble; capture on the document sees every element's.
  doc.addEventListener('scroll', onScroll, true);
  return () => doc.removeEventListener('scroll', onScroll, true);
}
