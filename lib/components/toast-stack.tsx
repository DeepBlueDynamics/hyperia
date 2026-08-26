// Stacking toast column (bottom-right). Unlike the legacy single-slot
// notification (lib/components/notifications.tsx), toasts STACK: a new toast
// slides in at the bottom and pushes the existing ones upward. Each toast
// auto-expires (default 30s) and carries a real close button.
//
// Module bus (same pattern as close-confirm-modal): callers use pushToast();
// the mounted <ToastStack /> renders whatever is live. Used by the drag-drop
// file-copy result; generic enough for any transient notice.
import React from 'react';

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

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: 9000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '8px',
        pointerEvents: 'none'
      }}
    >
      <style>{`
        @keyframes hyToastGrow {
          from { max-height: 0; opacity: 0; transform: translateY(10px); }
          to   { max-height: 140px; opacity: 1; transform: translateY(0); }
        }
        @keyframes hyToastShrink {
          from { max-height: 140px; opacity: 1; }
          to   { max-height: 0; opacity: 0; }
        }
        .hy-toast-close:hover { background: var(--border-neutral, rgba(255,255,255,0.15)); color: var(--text-primary, #fff); }
      `}</style>
      {toasts.map((t) => (
        <div
          key={t.id}
          // max-height animates so the OLDER toasts above slide up smoothly as
          // this one grows in (and back down as it collapses out).
          style={{
            overflow: 'hidden',
            maxHeight: '140px',
            animation: `${leaving.has(t.id) ? 'hyToastShrink' : 'hyToastGrow'} ${EXIT_MS}ms ease ${leaving.has(t.id) ? 'forwards' : ''}`,
            pointerEvents: 'auto'
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              maxWidth: '400px',
              padding: '10px 10px 10px 12px',
              borderRadius: '8px',
              border: `1px solid ${t.kind === 'error' ? 'var(--danger-text, #fe354e)' : 'var(--border-neutral, rgba(255,255,255,0.15))'}`,
              background: 'var(--bg-secondary, #1a1a1a)',
              boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
              color: 'var(--text-primary, #eee)',
              fontFamily: 'var(--font-sans, sans-serif)',
              fontSize: '12px',
              lineHeight: 1.45
            }}
          >
            <i
              className={t.kind === 'error' ? 'ti ti-alert-triangle' : 'ti ti-copy-check'}
              style={{
                fontSize: '14px',
                flexShrink: 0,
                marginTop: '1px',
                color: t.kind === 'error' ? 'var(--danger-text, #fe354e)' : 'var(--info-text, #7aa2f7)'
              }}
              aria-hidden="true"
            />
            <span style={{flex: 1, minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap'}}>{t.text}</span>
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
              style={{
                flexShrink: 0,
                width: '20px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '5px',
                cursor: 'pointer',
                color: 'var(--text-tertiary, #888)',
                fontSize: '14px',
                lineHeight: 1,
                userSelect: 'none'
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
