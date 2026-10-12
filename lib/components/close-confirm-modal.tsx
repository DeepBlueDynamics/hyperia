import React from 'react';

import {useSuppressWebPanes} from '../utils/web-pane-suppress';

import './close-confirm-modal.css';

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
  // Main also suppresses for window/quit; this covers every other path.
  useSuppressWebPanes(!!req, 'close-confirm');

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
      className="hy-closeconfirm-backdrop"
      // position stays inline: the web-pane-occluders test counts it per file
      style={{position: 'fixed'}}
    >
      <div className="hy-closeconfirm-card">
        <div className="hy-closeconfirm-head">
          <span className="hy-closeconfirm-icon">⚠️</span>
          <div className="hy-closeconfirm-title">{heading}</div>
        </div>
        <div className="hy-closeconfirm-lead">{lead}</div>
        {n.length > 1 && (
          <div className="hy-closeconfirm-names">
            {n.map((name, i) => (
              <div key={i}>• {name}</div>
            ))}
          </div>
        )}
        <div className="hy-closeconfirm-stop">
          {stopVerb} {n.length === 1 ? 'it' : 'them'}. {verb} anyway?
        </div>
        <div className="hy-closeconfirm-actions">
          <button type="button" onClick={() => done(false)} className="hy-closeconfirm-cancel">
            Cancel
          </button>
          <button type="button" onClick={() => done(true)} className="hy-closeconfirm-confirm">
            {verb}
          </button>
        </div>
      </div>
    </div>
  );
}
