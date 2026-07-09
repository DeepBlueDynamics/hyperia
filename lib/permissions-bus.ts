// Lightweight per-pane pub/sub for cross-pane access prompts.
//
// The sidecar pushes a `permission request` over the bridge → main → renderer
// rpc; `lib/index.tsx` feeds it here. Each PaneBand subscribes by its own
// paneId and slides a consent panel down when a request targets it. Kept as a
// standalone module (not the redux store) so the prompt is fully self-contained
// and easy to iterate on without touching reducer plumbing.

export type PermRequest = {
  id: string;
  requester: string;
  /** Friendly display name (pane codename, e.g. "Severe Booby 🥐") — prefer over `requester` in UI. */
  requesterName?: string;
  requesterPane: string;
  targetPane: string;
  /** Caller-supplied rationale (from request_access purpose=); shown on the prompt. */
  purpose?: string;
};

type Listener = (req: PermRequest | null) => void;

const current = new Map<string, PermRequest>();
const listeners = new Map<string, Set<Listener>>();

// Window-level subscribers (the centered consent modal) — see ALL pending
// requests at once, regardless of which pane/tab owns them.
const allListeners = new Set<(reqs: PermRequest[]) => void>();

function emitAll(): void {
  const list = Array.from(current.values());
  allListeners.forEach((cb) => cb(list));
}

function emit(paneId: string): void {
  const req = current.get(paneId) || null;
  listeners.get(paneId)?.forEach((cb) => cb(req));
  emitAll();
  emitOverlay();
}

// ---------------------------------------------------------------------------
// "Overlay active" — true whenever ANY permission UI is on screen (a per-pane
// consent panel OR a window-level create toast). Web panes subscribe to this
// and hide their native WebContentsView while it's true: a native view paints
// ABOVE all DOM regardless of z-index, so a consent prompt would otherwise be
// occluded by an open web pane.
// ---------------------------------------------------------------------------
const overlayListeners = new Set<(active: boolean) => void>();
function overlayActive(): boolean {
  return toasts.size > 0 || current.size > 0;
}
function emitOverlay(): void {
  const a = overlayActive();
  overlayListeners.forEach((cb) => cb(a));
}
export function subscribePermsOverlay(cb: (active: boolean) => void): () => void {
  overlayListeners.add(cb);
  cb(overlayActive());
  return () => {
    overlayListeners.delete(cb);
  };
}

/** A request arrived for a pane — show its prompt. */
export function setRequest(req: PermRequest): void {
  if (!req.targetPane) return;
  current.set(req.targetPane, req);
  emit(req.targetPane);
}

/** The request for a pane was answered (or the pane closed) — dismiss it. */
export function clearRequest(paneId: string): void {
  if (current.delete(paneId)) emit(paneId);
}

/**
 * Subscribe the window-level modal to every pending consent request. Fires
 * immediately with the current list.
 */
export function subscribeAllRequests(cb: (reqs: PermRequest[]) => void): () => void {
  allListeners.add(cb);
  cb(Array.from(current.values()));
  return () => {
    allListeners.delete(cb);
  };
}

/** Subscribe a pane to its own prompt. Fires immediately with current state. */
export function subscribe(paneId: string, cb: Listener): () => void {
  let set = listeners.get(paneId);
  if (!set) {
    set = new Set();
    listeners.set(paneId, set);
  }
  set.add(cb);
  cb(current.get(paneId) || null);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(paneId);
  };
}

// ---------------------------------------------------------------------------
// Create-consent toasts — a global (not per-pane) channel. A new tab/window
// has no target pane, so these render as a window-level toast.
// ---------------------------------------------------------------------------

export type ToastRequest = {
  id: string;
  requester: string;
  /** Friendly display name (pane codename) — prefer over `requester` in UI. */
  requesterName?: string;
  action: string; // create_pane | create_tab | create_window | create_web | create_sticky
};

const toasts = new Map<string, ToastRequest>(); // id → request
const toastListeners = new Set<(reqs: ToastRequest[]) => void>();

function emitToasts(): void {
  const list = Array.from(toasts.values());
  toastListeners.forEach((cb) => cb(list));
  emitOverlay();
}

export function setToast(req: ToastRequest): void {
  if (!req.id) return;
  toasts.set(req.id, req);
  emitToasts();
}

export function clearToast(id: string): void {
  if (toasts.delete(id)) emitToasts();
}

export function subscribeToasts(cb: (reqs: ToastRequest[]) => void): () => void {
  toastListeners.add(cb);
  cb(Array.from(toasts.values()));
  return () => {
    toastListeners.delete(cb);
  };
}
