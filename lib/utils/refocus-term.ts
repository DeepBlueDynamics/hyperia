// After the human answers a prompt, give the keyboard back to the pane they were
// in. Only when focus was lost to the page (a clicked button that unmounted), so
// it never moves them anywhere else.
export function refocusTermIfLost(delayMs = 150): void {
  setTimeout(() => {
    const el = document.activeElement;
    if (!el || el === document.body) window.focusActiveTerm?.();
  }, delayMs);
}
