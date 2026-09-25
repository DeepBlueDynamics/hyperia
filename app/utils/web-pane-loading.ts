// Main-frame-only loading state for a web pane's spinner / Stop button.
// Only a main-frame, cross-document navigation turns it on.

export type WebPaneLoadEvent =
  | {type: 'start-navigation'; isMainFrame: boolean; isSameDocument: boolean}
  | {type: 'finish-load'}
  | {type: 'fail-load'; isMainFrame: boolean; errorCode: number}
  | {type: 'stop-loading'}
  | {type: 'stop'};

// ERR_ABORTED usually means a newer navigation replaced this one; keep its spinner.
const ERR_ABORTED = -3;

/**
 * The main-frame loading state after `ev`, given the current state `loading`.
 * Returns `null` when the event does not change the state (nothing to push).
 */
export function nextMainFrameLoading(loading: boolean, ev: WebPaneLoadEvent): boolean | null {
  let next: boolean = loading;
  switch (ev.type) {
    case 'start-navigation':
      if (ev.isMainFrame && !ev.isSameDocument) next = true;
      break;
    case 'finish-load':
    case 'stop-loading':
    case 'stop':
      next = false;
      break;
    case 'fail-load':
      if (ev.isMainFrame && ev.errorCode !== ERR_ABORTED) next = false;
      break;
  }
  return next === loading ? null : next;
}
