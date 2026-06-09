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
  requesterPane: string;
  targetPane: string;
};

type Listener = (req: PermRequest | null) => void;

const current = new Map<string, PermRequest>();
const listeners = new Map<string, Set<Listener>>();

function emit(paneId: string): void {
  const req = current.get(paneId) || null;
  listeners.get(paneId)?.forEach((cb) => cb(req));
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
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(paneId);
  };
}

// ---------------------------------------------------------------------------
// Create-consent toasts — a global (not per-pane) channel. A new tab/window
// has no target pane, so these render as a window-level toast.
// ---------------------------------------------------------------------------

export type ToastRequest = {
  id: string;
  requester: string;
  action: string; // create_pane | create_tab | create_window | create_web | create_sticky
};

const toasts = new Map<string, ToastRequest>(); // id → request
const toastListeners = new Set<(reqs: ToastRequest[]) => void>();

function emitToasts(): void {
  const list = Array.from(toasts.values());
  toastListeners.forEach((cb) => cb(list));
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
