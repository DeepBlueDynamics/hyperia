// Main-frame-only loading state for a web pane's spinner / Stop button.
// Only a main-frame, cross-document navigation turns it on.

export type WebPaneLoadEvent =
  | {type: 'start-navigation'; isMainFrame: boolean; isSameDocument: boolean; url?: string}
  | {type: 'commit'}
  | {type: 'finish-load'}
  | {type: 'fail-load'; isMainFrame: boolean; errorCode: number; provisional: boolean; url?: string}
  | {type: 'abort-settle'; navSeq: number}
  | {type: 'stop-loading'}
  | {type: 'stop'};

export type WebPaneLoadState = {
  loading: boolean;
  // A main-frame navigation has started but not yet committed or failed.
  pending: boolean;
  // Bumped per main-frame navigation start, so an abort can tell if one replaced it.
  navSeq: number;
  // URL of the pending navigation, so a late abort of an older one can't clear it.
  pendingUrl?: string;
};

export const ERR_ABORTED = -3;

export const initialLoadState: WebPaneLoadState = {loading: false, pending: false, navSeq: 0};

/** The loading state after `ev`. Returns `s` itself when nothing changed. */
export function nextLoadState(s: WebPaneLoadState, ev: WebPaneLoadEvent): WebPaneLoadState {
  switch (ev.type) {
    case 'start-navigation':
      if (!ev.isMainFrame || ev.isSameDocument) return s;
      return {loading: true, pending: true, navSeq: s.navSeq + 1, ...(ev.url ? {pendingUrl: ev.url} : {})};
    case 'commit':
      return s.pending ? {...s, pending: false} : s;
    case 'finish-load':
    case 'stop-loading':
      // The old page's finish can land after the next navigation has started.
      if (s.pending || !s.loading) return s;
      return {...s, loading: false};
    case 'fail-load':
      if (!ev.isMainFrame) return s;
      // An abort is settled on the next tick (abort-settle): a replacement may be starting.
      if (ev.errorCode === ERR_ABORTED) {
        // The old navigation's abort can arrive after its replacement started.
        const stale = ev.url && s.pendingUrl && ev.url !== s.pendingUrl;
        return ev.provisional && s.pending && !stale ? {...s, pending: false} : s;
      }
      return s.loading || s.pending ? {...s, loading: false, pending: false} : s;
    case 'abort-settle':
      if (s.navSeq !== ev.navSeq || s.pending || !s.loading) return s;
      return {...s, loading: false};
    case 'stop':
      return s.loading || s.pending ? {...s, loading: false, pending: false} : s;
  }
  return s;
}
