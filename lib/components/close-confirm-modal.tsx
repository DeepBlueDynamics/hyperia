import React from 'react';

// In-app (styled) confirmation for closing a window/tab or quitting when panes
// are running a foreground program. Replaces the native OS dialog. Driven by a
// tiny module bus that lib/index.tsx feeds from the main-process 'close-confirm'
// rpc; the answer callback rpc-replies to main. (#148)

export type CloseConfirmReq = {
  id: number;
  scope: 'window' | 'quit' | 'tab';
  names: string[];
  tabCount?: number;
  paneCount?: number;
  answer: (ok: boolean) => void;
};

let current: CloseConfirmReq | null = null;
const listeners = new Set<(r: CloseConfirmReq | null) => void>();
function emit(): void {
  listeners.forEach((cb) => cb(current));
}
export function showCloseConfirm(req: CloseConfirmReq): void {
  current = req;
  emit();
}
export function clearCloseConfirm(): void {
  current = null;
  emit();
}
function subscribe(cb: (r: CloseConfirmReq | null) => void): () => void {
  listeners.add(cb);
  cb(current);
  return () => {
    listeners.delete(cb);
  };
}

export default function CloseConfirmModal(): JSX.Element | null {
  const [req, setReq] = React.useState<CloseConfirmReq | null>(null);
  React.useEffect(() => subscribe(setReq), []);

  const done = React.useCallback((ok: boolean) => {
    if (current) current.answer(ok);
    clearCloseConfirm();
  }, []);

  React.useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req, done]);

  if (!req) return null;

  const verb = req.scope === 'quit' ? 'Quit' : req.scope === 'tab' ? 'Close tab' : 'Close window';
  const n = req.names.filter(Boolean);
  const heading = n.length > 0 ? 'Active processes still running' : req.scope === 'quit' ? 'Quit Hyperia?' : 'Close?';
  const lead =
    n.length === 0
      ? req.tabCount && req.tabCount > 1
        ? `This will close all ${req.tabCount} tabs and their sessions.`
        : 'This will end the sessions inside.'
      : n.length === 1
        ? `A pane is still running “${n[0]}”.`
        : `${n.length} panes are still running:`;
  const stopVerb =
    req.scope === 'quit'
      ? 'Quitting will stop'
      : req.scope === 'tab'
        ? 'Closing this tab will stop'
        : 'Closing will stop';

  return (
    <div
      onMouseDown={(e) => {
        // Backdrop click = Cancel (safe default).
        if (e.target === e.currentTarget) done(false);
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(2px)'
      }}
    >
      <div
        style={{
          minWidth: 340,
          maxWidth: 460,
          background: 'var(--bg-secondary, #1a1a24)',
          border: '0.5px solid var(--border-neutral, #33333f)',
          borderRadius: 10,
          boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
          padding: '18px 20px 16px',
          fontFamily: 'var(--font-sans, system-ui, sans-serif)',
          color: 'var(--text-primary, #e6e6ee)'
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
          <span style={{fontSize: 16}}>⚠️</span>
          <div style={{fontSize: 14, fontWeight: 600}}>{heading}</div>
        </div>
        <div style={{fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary, #b8b8c8)'}}>{lead}</div>
        {n.length > 1 && (
          <div
            style={{
              margin: '8px 0 2px',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 12,
              color: 'var(--text-primary, #e6e6ee)',
              maxHeight: 120,
              overflowY: 'auto'
            }}
          >
            {n.map((name, i) => (
              <div key={i}>• {name}</div>
            ))}
          </div>
        )}
        <div style={{fontSize: 12.5, color: 'var(--text-secondary, #b8b8c8)', marginTop: 8}}>
          {stopVerb} {n.length === 1 ? 'it' : 'them'}. {verb} anyway?
        </div>
        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16}}>
          <button
            type="button"
            onClick={() => done(false)}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              borderRadius: 6,
              border: '0.5px solid var(--border-neutral, #44444f)',
              background: 'transparent',
              color: 'var(--text-primary, #e6e6ee)',
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => done(true)}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 6,
              border: 'none',
              background: 'var(--accent-danger, #d9534f)',
              color: '#fff',
              cursor: 'pointer'
            }}
          >
            {verb}
          </button>
        </div>
      </div>
    </div>
  );
}
