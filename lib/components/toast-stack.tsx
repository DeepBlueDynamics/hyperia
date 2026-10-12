// Stacking toast column (bottom-right). Unlike the legacy single-slot
// notification (lib/components/notifications.tsx), toasts STACK: a new toast
// slides in at the bottom and pushes the existing ones upward. Each toast
// auto-expires (default 30s) and carries a real close button.
//
// Module bus (same pattern as close-confirm-modal): callers use pushToast();
// the mounted <ToastStack /> renders whatever is live. Used by the drag-drop
// file-copy result; generic enough for any transient notice.
import React from 'react';

import {onToastLayerAction, setLayerToasts, useToastLayer} from '../toast-layer';

import './toast-stack.css';

export interface ToastOptions {
  kind?: 'info' | 'error';
  /** Auto-expire after this many ms (default 30s). */
  ttlMs?: number;
}

interface ToastItem {
  id: number;
  text: string;
  kind: 'info' | 'error';
  ttlMs: number;
  /** Present on sticky toasts — the caller-owned identity used to update/dismiss. */
  stickyKey?: string;
}

let nextToastId = 1;
let pushImpl: ((t: Omit<ToastItem, 'id'>) => void) | null = null;
let dismissStickyImpl: ((key: string) => void) | null = null;

export function pushToast(text: string, opts?: ToastOptions): void {
  pushImpl?.({
    text,
    kind: opts?.kind ?? 'info',
    ttlMs: Math.max(1000, opts?.ttlMs ?? 30000)
  });
}

// Sticky toast: stays up until dismissStickyToast(key) — for ongoing activity
// ("🔊 X is playing audio"). Same key updates the text in place. A 10-minute
// safety TTL backs it so a lost end-event can't pin a toast forever; the ×
// still dismisses manually.
const STICKY_SAFETY_TTL_MS = 10 * 60 * 1000;

export function pushStickyToast(key: string, text: string, opts?: Pick<ToastOptions, 'kind'>): void {
  pushImpl?.({
    text,
    kind: opts?.kind ?? 'info',
    ttlMs: STICKY_SAFETY_TTL_MS,
    stickyKey: key
  });
}

export function dismissStickyToast(key: string): void {
  dismissStickyImpl?.(key);
}

// Keep in sync with the 180ms animations in toast-stack.css.
const EXIT_MS = 180;

export default function ToastStack(): React.ReactElement | null {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const [leaving, setLeaving] = React.useState<ReadonlySet<number>>(new Set());
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // stickyKey → toast id, tracked outside React state so push/dismiss can
  // resolve keys synchronously (a flag inside a setState updater is not
  // reliable under React 18 batching).
  const stickyIds = React.useRef(new Map<string, number>());

  const remove = React.useCallback((id: number) => {
    setToasts((s) => s.filter((t) => t.id !== id));
    setLeaving((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    for (const [key, tid] of stickyIds.current) {
      if (tid === id) stickyIds.current.delete(key);
    }
  }, []);

  // Exit in two steps: mark leaving (plays the collapse animation), then drop.
  const beginDismiss = React.useCallback(
    (id: number) => {
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      timers.current.delete(id);
      setLeaving((s) => (s.has(id) ? s : new Set(s).add(id)));
      setTimeout(() => remove(id), EXIT_MS);
    },
    [remove]
  );

  React.useEffect(() => {
    pushImpl = (t) => {
      // Sticky upsert: same key updates the existing toast's text in place
      // (timer untouched) instead of stacking a duplicate.
      const existing = t.stickyKey ? stickyIds.current.get(t.stickyKey) : undefined;
      if (existing !== undefined) {
        setToasts((s) => s.map((x) => (x.id === existing ? {...x, text: t.text, kind: t.kind} : x)));
        return;
      }
      const id = nextToastId++;
      if (t.stickyKey) stickyIds.current.set(t.stickyKey, id);
      setToasts((s) => [...s, {...t, id}]);
      timers.current.set(
        id,
        setTimeout(() => beginDismiss(id), t.ttlMs)
      );
    };
    dismissStickyImpl = (key) => {
      const id = stickyIds.current.get(key);
      if (id !== undefined) {
        stickyIds.current.delete(key);
        beginDismiss(id);
      }
    };
    const pending = timers.current;
    return () => {
      pushImpl = null;
      dismissStickyImpl = null;
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, [beginDismiss]);

  // On the native layer the stack draws above web panes; the DOM below is the
  // fallback when the layer isn't available.
  const layer = useToastLayer();
  React.useEffect(() => {
    if (!layer) return;
    setLayerToasts(
      'toast-stack',
      0,
      toasts
        .filter((t) => !leaving.has(t.id))
        .map((t) => ({id: `stack-${t.id}`, kind: 'toast', text: t.text, tone: t.kind, dismissable: true})),
      'bottom-right'
    );
  }, [layer, toasts, leaving]);
  React.useEffect(() => {
    if (!layer) return;
    return onToastLayerAction(({toastId, buttonId}) => {
      if (buttonId === 'close' && toastId.startsWith('stack-')) beginDismiss(Number(toastId.slice(6)));
    });
  }, [layer, beginDismiss]);

  if (layer || toasts.length === 0) return null;

  return (
    // position stays inline: the web-pane-occluders test counts it per file
    <div className="hy-toast-stack" style={{position: 'fixed'}}>
      {toasts.map((t) => (
        <div key={t.id} className={leaving.has(t.id) ? 'hy-toast-item hy-toast-item--leaving' : 'hy-toast-item'}>
          <div className={t.kind === 'error' ? 'hy-toast-body hy-toast-body--error' : 'hy-toast-body'}>
            <i
              className={
                t.kind === 'error'
                  ? 'ti ti-alert-triangle hy-toast-icon hy-toast-icon--error'
                  : 'ti ti-copy-check hy-toast-icon'
              }
              aria-hidden="true"
            />
            <span className="hy-toast-text">{t.text}</span>
            <span
              className="hy-toast-close"
              role="button"
              aria-label="Dismiss"
              title="Dismiss"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                beginDismiss(t.id);
              }}
            >
              ×
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
