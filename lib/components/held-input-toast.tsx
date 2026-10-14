// Top-right prompt when an agent's input is held because the human is in the
// target pane. "Send now" releases it and takes the keyboard out of the pane so
// the human's typing can't land in the middle of it. "Later" keeps waiting:
// the input goes in once the human leaves the pane, as before.
import {ipcRenderer} from 'electron';
import React from 'react';

import rpc from '../rpc';
import {onToastLayerAction, setLayerToasts, useToastLayer} from '../toast-layer';
import type {ToastLayerItem} from '../toast-layer';

import './held-input-toast.css';

export interface HeldInput {
  opId: string;
  pane: string;
  kind: string;
  from: string;
  preview: string;
}

// Wait out the layer handing focus back to the host before blurring the pane.
const BLUR_AFTER_MS = 200;

export function heldInputText(h: HeldInput): string {
  const verb = h.kind === 'keys' ? 'send keys to' : h.kind === 'shell' ? 'run a command in' : 'type into';
  return h.preview ? `wants to ${verb} this pane: “${h.preview}”` : `wants to ${verb} this pane.`;
}

const LAYER_BUTTONS: ToastLayerItem['buttons'] = [
  {id: 'later', label: 'Later'},
  {id: 'send', label: 'Send now', style: 'allow'}
];

export function layerItemsFor(held: HeldInput[]): ToastLayerItem[] {
  return held.map((h) => ({
    id: h.opId,
    kind: 'card',
    emoji: '⌨️',
    who: h.from,
    text: heldInputText(h),
    buttons: LAYER_BUTTONS
  }));
}

function release(opId: string): void {
  void ipcRenderer
    .invoke('input-held:release', {opId})
    .then(() => {
      setTimeout(() => {
        const el = document.activeElement as HTMLElement | null;
        el?.blur?.();
      }, BLUR_AFTER_MS);
    })
    .catch((err) => console.error('held-input release failed:', err));
}

export default function HeldInputToast(): React.ReactElement | null {
  const [held, setHeld] = React.useState<HeldInput[]>([]);
  const layer = useToastLayer();

  const drop = React.useCallback((opId: string) => setHeld((s) => s.filter((h) => h.opId !== opId)), []);

  React.useEffect(() => {
    const onHeld = (h: HeldInput) => {
      if (!h?.opId) return;
      setHeld((s) => [...s.filter((x) => x.opId !== h.opId), h]);
    };
    const onCleared = ({opId}: {opId: string}) => drop(opId);
    rpc.on('input held', onHeld);
    rpc.on('input held cleared', onCleared);
    return () => {
      rpc.removeListener('input held', onHeld);
      rpc.removeListener('input held cleared', onCleared);
    };
  }, [drop]);

  const decide = React.useCallback(
    (opId: string, choice: string) => {
      if (choice === 'send') release(opId);
      if (choice === 'send' || choice === 'later') drop(opId);
    },
    [drop]
  );

  React.useEffect(() => {
    if (!layer) return undefined;
    setLayerToasts('held-input', 0, layerItemsFor(held), 'top-right');
    return () => setLayerToasts('held-input', 0, [], 'top-right');
  }, [layer, held]);

  React.useEffect(() => {
    if (!layer) return undefined;
    return onToastLayerAction(({toastId, buttonId}) => {
      if (held.some((h) => h.opId === toastId)) decide(toastId, buttonId);
    });
  }, [layer, held, decide]);

  if (layer || !held.length) return null;
  return (
    <div className="hy-held-input-stack" style={{position: 'fixed'}}>
      {held.map((h) => (
        <div key={h.opId} className="hy-held-input-card">
          <div className="hy-held-input-head">
            <span>⌨️</span>
            <span>
              <b>{h.from}</b> <span className="hy-held-input-muted">{heldInputText(h)}</span>
            </span>
          </div>
          <div className="hy-held-input-actions">
            <button type="button" className="hy-held-input-btn" onClick={() => decide(h.opId, 'later')}>
              Later
            </button>
            <button
              type="button"
              className="hy-held-input-btn hy-held-input-btn--send"
              onClick={() => decide(h.opId, 'send')}
            >
              Send now
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
