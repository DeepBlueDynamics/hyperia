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

// Requests whose PROMPT timed out (or was snoozed by a backdrop click) but are
// still pending sidecar-side. They collapse into a persistent "pending
// approvals" pill instead of vanishing — before this, a 45s TTL silently
// deleted an unseen prompt and the requesting agent waited forever with the
// human never knowing anything was asked ("Bass can't connect").
const expired = new Map<string, PermRequest>();
const expiredListeners = new Set<(reqs: PermRequest[]) => void>();

function emitExpired(): void {
  const list = Array.from(expired.values());
  expiredListeners.forEach((cb) => cb(list));
}

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

// Safety net (#156): a prompt whose "resolved" event is missed — server-side
// timeout, answered out-of-band, or requester/target pane torn down without a
// clear — must NOT leave `overlayActive()` stuck true, which hides EVERY web
// pane's native view indefinitely (the "google + maps both frozen" wedge).
// Every set schedules an auto-clear that a matching clear cancels.
const OVERLAY_TTL_MS = 45000;
const reqTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** A request arrived for a pane — show its prompt. */
export function setRequest(req: PermRequest): void {
  if (!req.targetPane) return;
  if (expired.delete(req.targetPane)) emitExpired();
  current.set(req.targetPane, req);
  const prev = reqTimers.get(req.targetPane);
  if (prev) clearTimeout(prev);
  reqTimers.set(
    req.targetPane,
    setTimeout(() => expireRequest(req.targetPane), OVERLAY_TTL_MS)
  );
  emit(req.targetPane);
}

/**
 * The prompt timed out (or was snoozed) — collapse it to the pending pill.
 * The overlay releases (web panes un-hide, the #156 safety net stays intact)
 * but the request survives; reviveRequest() brings the modal back.
 */
export function expireRequest(paneId: string): void {
  const req = current.get(paneId);
  if (!req) return;
  const t = reqTimers.get(paneId);
  if (t) {
    clearTimeout(t);
    reqTimers.delete(paneId);
  }
  current.delete(paneId);
  expired.set(paneId, req);
  emit(paneId);
  emitExpired();
}

/** Re-open the full prompt for a collapsed (expired/snoozed) request. */
export function reviveRequest(paneId: string): void {
  const req = expired.get(paneId);
  if (!req) return;
  expired.delete(paneId);
  emitExpired();
  setRequest(req);
}

/** The request for a pane was answered (or the pane closed) — dismiss it. */
export function clearRequest(paneId: string): void {
  const t = reqTimers.get(paneId);
  if (t) {
    clearTimeout(t);
    reqTimers.delete(paneId);
  }
  if (expired.delete(paneId)) emitExpired();
  if (current.delete(paneId)) emit(paneId);
}

/**
 * Subscribe to COLLAPSED (expired/snoozed but still pending) requests — the
 * "pending approvals" pill. Fires immediately with the current list.
 */
export function subscribeExpiredRequests(cb: (reqs: PermRequest[]) => void): () => void {
  expiredListeners.add(cb);
  cb(Array.from(expired.values()));
  return () => {
    expiredListeners.delete(cb);
  };
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

// Toasts whose 45s prompt elapsed unanswered. They collapse into a pill (same
// contract as per-pane `expired` requests) instead of being DELETED — before
// this, a create prompt that fired while the human was away simply vanished,
// the sidecar kept its pending request, retries deduped against it silently,
// and the human stood at the window saying "I see no approval" while the
// agent waited forever.
const expiredToasts = new Map<string, ToastRequest>();
const expiredToastListeners = new Set<(reqs: ToastRequest[]) => void>();

function emitExpiredToasts(): void {
  const list = Array.from(expiredToasts.values());
  expiredToastListeners.forEach((cb) => cb(list));
}

function emitToasts(): void {
  const list = Array.from(toasts.values());
  toastListeners.forEach((cb) => cb(list));
  emitOverlay();
}

const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function setToast(req: ToastRequest): void {
  if (!req.id) return;
  if (expiredToasts.delete(req.id)) emitExpiredToasts();
  toasts.set(req.id, req);
  const prev = toastTimers.get(req.id);
  if (prev) clearTimeout(prev);
  toastTimers.set(req.id, setTimeout(() => expireToast(req.id), OVERLAY_TTL_MS));
  emitToasts();
}

/** The toast timed out unanswered — collapse it to the pending pill. */
export function expireToast(id: string): void {
  const req = toasts.get(id);
  if (!req) return;
  const t = toastTimers.get(id);
  if (t) {
    clearTimeout(t);
    toastTimers.delete(id);
  }
  toasts.delete(id);
  expiredToasts.set(id, req);
  emitToasts();
  emitExpiredToasts();
}

/** Re-open the full toast for a collapsed (expired) create request. */
export function reviveToast(id: string): void {
  const req = expiredToasts.get(id);
  if (!req) return;
  setToast(req);
}

export function clearToast(id: string): void {
  const t = toastTimers.get(id);
  if (t) {
    clearTimeout(t);
    toastTimers.delete(id);
  }
  if (expiredToasts.delete(id)) emitExpiredToasts();
  if (toasts.delete(id)) emitToasts();
}

export function subscribeToasts(cb: (reqs: ToastRequest[]) => void): () => void {
  toastListeners.add(cb);
  cb(Array.from(toasts.values()));
  return () => {
    toastListeners.delete(cb);
  };
}

/** Subscribe to collapsed (expired but still pending) create toasts. */
export function subscribeExpiredToasts(cb: (reqs: ToastRequest[]) => void): () => void {
  expiredToastListeners.add(cb);
  cb(Array.from(expiredToasts.values()));
  return () => {
    expiredToastListeners.delete(cb);
  };
}
