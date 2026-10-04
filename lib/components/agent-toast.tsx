import {ipcRenderer} from 'electron';
import React from 'react';

import {subscribeToasts, subscribeExpiredToasts, reviveToast, clearToast, type ToastRequest} from '../permissions-bus';
import {onToastLayerAction, setLayerToasts, useToastLayer} from '../toast-layer';
import type {ToastLayerItem} from '../toast-layer';

// action → full verb phrase for the prompt ("wants to <phrase>").
const CREATE_SURFACE: Record<string, string> = {
  create_pane: 'open a new pane',
  create_tab: 'open a new tab',
  create_window: 'open a new window',
  create_web: 'open a web pane',
  create_sticky: 'create a sticky note'
};
const CAP_PHRASE: Record<string, string> = {
  'cap:files': 'edit files on disk',
  'cap:settings': 'change Hyperia settings',
  'cap:web_eval': 'run JavaScript in a web pane',
  'cap:web_nav': 'read & interact with web panes',
  'cap:manage': 'close / manage panes & tabs'
};
function actionPhrase(action: string): string {
  if (action === 'cap:sticky:list_all') {
    return 'search and list all sticky notes';
  }
  if (action.startsWith('cap:sticky:access:')) {
    return 'read and write sticky note ' + action.slice('cap:sticky:access:'.length);
  }
  return CREATE_SURFACE[action] || CAP_PHRASE[action] || 'perform an action';
}

function respond(id: string, body: Record<string, unknown>): void {
  void ipcRenderer
    .invoke('consent:respond', {id, action: 'create', ...body})
    .then((result) => {
      // The request is gone sidecar-side (expired or already answered): nothing
      // left to decide, so close the toast instead of leaving it stuck.
      if (result?.gone) {
        clearToast(id);
        return;
      }
      if (!result?.ok) throw new Error(result?.error || 'Approval was not recorded.');
      clearToast(id);
    })
    .catch((err) => console.error('create-consent respond failed:', err));
}

// The five decisions, keyed by the button id the toast layer echoes back.
const DECISIONS: Record<string, Record<string, unknown>> = {
  deny: {decision: 'deny'},
  once: {decision: 'allow', scope: 'once'},
  '15m': {decision: 'allow', durationSecs: 900},
  '1h': {decision: 'allow', durationSecs: 3600},
  always: {decision: 'allow', durationSecs: null}
};
const LAYER_BUTTONS: ToastLayerItem['buttons'] = [
  {id: 'deny', label: 'Deny', style: 'deny'},
  {id: 'once', label: 'Just once'},
  {id: '15m', label: '15 min'},
  {id: '1h', label: '1 hour'},
  {id: 'always', label: 'Always', style: 'allow'}
];
const AGENT_PILL_ID = 'agent-toast-pill';

function pillText(expired: ToastRequest[]): string {
  const first = expired[0];
  return expired.length === 1
    ? `${first.requesterName || first.requester} is waiting to ${actionPhrase(first.action)} — click to review`
    : `${expired.length} agent requests waiting — click to review`;
}

// What the native toast layer shows for the current requests + collapsed pill.
export function layerItemsFor(reqs: ToastRequest[], expired: ToastRequest[]): ToastLayerItem[] {
  const items: ToastLayerItem[] = reqs.map((r) => ({
    id: r.id,
    kind: 'card',
    emoji: '🤖',
    who: r.requesterName || r.requester,
    text: `wants to ${actionPhrase(r.action)}.`,
    buttons: LAYER_BUTTONS
  }));
  if (!reqs.length && expired.length) {
    items.push({id: AGENT_PILL_ID, kind: 'pill', emoji: '🤖', text: pillText(expired), title: 'Click to review'});
  }
  return items;
}

const btn: React.CSSProperties = {
  padding: '5px 12px',
  fontSize: '12px',
  fontWeight: 600,
  borderRadius: '6px',
  border: '1px solid var(--border-neutral, rgba(255,255,255,0.15))',
  background: 'transparent',
  color: 'var(--text-primary, #e8e8ea)',
  cursor: 'pointer'
};
const allowBtn: React.CSSProperties = {
  ...btn,
  borderColor: 'var(--accent-success, #3fb950)',
  background: 'var(--accent-success, #3fb950)',
  color: '#06140a'
};
const denyBtn: React.CSSProperties = {
  ...btn,
  borderColor: 'var(--accent-danger, #f85149)',
  color: 'var(--accent-danger, #f85149)'
};

// Window-level create-consent toast. A new tab/window has no target pane, so
// these can't live in a pane band — they stack top-center over everything.
//
// Rendering has two paths. With the native toast layer (the normal case) the
// cards and pill are drawn by a transparent WebContentsView ABOVE the window's
// web panes, over the live page (#297); this component only describes them and
// handles the clicks relayed back. Without it (layer unavailable) it renders
// the DOM version below, and the permissions bus freeze-swaps web panes.
export default function AgentToast(): React.ReactElement | null {
  const [reqs, setReqs] = React.useState<ToastRequest[]>([]);
  const [expired, setExpired] = React.useState<ToastRequest[]>([]);
  React.useEffect(() => subscribeToasts(setReqs), []);
  React.useEffect(() => subscribeExpiredToasts(setExpired), []);
  const layer = useToastLayer();

  React.useEffect(() => {
    if (!layer) return undefined;
    setLayerToasts('agent-toast', 0, layerItemsFor(reqs, expired));
    return () => setLayerToasts('agent-toast', 0, []);
  }, [layer, reqs, expired]);

  React.useEffect(() => {
    if (!layer) return undefined;
    return onToastLayerAction(({toastId, buttonId}) => {
      if (toastId === AGENT_PILL_ID) {
        if (expired[0]) reviveToast(expired[0].id);
        return;
      }
      const body = DECISIONS[buttonId];
      if (body && reqs.some((r) => r.id === toastId)) respond(toastId, body);
    });
  }, [layer, reqs, expired]);

  if (layer) return null;

  if (!reqs.length) {
    // Unanswered toasts collapse to a persistent pill (mirrors the per-pane
    // consent pill) instead of vanishing — the request is STILL pending
    // sidecar-side, and the agent is still waiting on it. Click to re-open.
    // Parked below the consent pill's spot so the two never overlap.
    if (!expired.length) return null;
    const first = expired[0];
    return (
      <div
        onClick={() => reviveToast(first.id)}
        title="Click to review"
        style={{
          position: 'fixed',
          top: 48,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 99998,
          ['WebkitAppRegion' as any]: 'no-drag',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 14px',
          borderRadius: '999px',
          border: '1px solid var(--accent-primary, #6ea8fe)',
          background: 'var(--bg-elevated, var(--bg-secondary, #1c1c22))',
          color: 'var(--text-primary, #e8e8ea)',
          fontFamily: 'var(--font-sans)',
          fontSize: '12px',
          fontWeight: 500,
          cursor: 'pointer',
          boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
          animation: 'hyToastPill 2.4s ease-in-out infinite'
        }}
      >
        <style>{`@keyframes hyToastPill{0%,100%{box-shadow:0 6px 20px rgba(0,0,0,0.45)}50%{box-shadow:0 0 14px 2px var(--accent-primary, #6ea8fe)}}`}</style>
        <span style={{fontSize: '14px', lineHeight: 1}}>🤖</span>
        <span>{pillText(expired)}</span>
      </div>
    );
  }
  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 99999,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        pointerEvents: 'none'
      }}
    >
      <style>{`@keyframes hyToastIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      {reqs.map((r) => (
        <div
          key={r.id}
          style={{
            pointerEvents: 'auto',
            // Top-center = the frameless window's drag strip; without no-drag,
            // clicks on the card's TOP edge start a window drag instead of
            // reaching the buttons (same bug as the consent pill).
            ['WebkitAppRegion' as any]: 'no-drag',
            background: 'var(--bg-elevated, var(--bg-secondary, #1c1c22))',
            border: '1px solid var(--accent-primary, #6ea8fe)',
            borderRadius: '10px',
            boxShadow: '0 12px 28px rgba(0,0,0,0.5)',
            padding: '12px 14px',
            minWidth: '340px',
            color: 'var(--text-primary, #e8e8ea)',
            fontFamily: 'var(--font-sans)',
            animation: 'hyToastIn 160ms ease'
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '10px',
              fontSize: '12.5px',
              lineHeight: 1.35
            }}
          >
            <span style={{fontSize: '15px'}}>🤖</span>
            <span>
              <b>{r.requesterName || r.requester}</b>
              <span style={{color: 'var(--text-secondary, #9a9aa2)'}}> wants to {actionPhrase(r.action)}.</span>
            </span>
          </div>
          <div style={{display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap'}}>
            <button type="button" style={denyBtn} onClick={() => respond(r.id, DECISIONS.deny)}>
              Deny
            </button>
            <button type="button" style={btn} onClick={() => respond(r.id, DECISIONS.once)}>
              Just once
            </button>
            <button type="button" style={btn} onClick={() => respond(r.id, DECISIONS['15m'])}>
              15 min
            </button>
            <button type="button" style={btn} onClick={() => respond(r.id, DECISIONS['1h'])}>
              1 hour
            </button>
            <button type="button" style={allowBtn} onClick={() => respond(r.id, DECISIONS.always)}>
              Always
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
