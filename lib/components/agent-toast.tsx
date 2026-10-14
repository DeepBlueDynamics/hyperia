import {ipcRenderer} from 'electron';
import React from 'react';

import {subscribeToasts, subscribeExpiredToasts, reviveToast, clearToast, type ToastRequest} from '../permissions-bus';
import {onToastLayerAction, setLayerToasts, useToastLayer} from '../toast-layer';
import type {ToastLayerItem} from '../toast-layer';

import './agent-toast.css';

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

// Window-level create-consent toast. A new tab/window has no target pane, so
// these can't live in a pane band — the cards stack mid-window over everything.
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
    // Cards sit mid-window like the pane-access prompt; the collapsed pill
    // stays in the top strip.
    const items = layerItemsFor(reqs, expired);
    setLayerToasts(
      'agent-toast',
      0,
      items.filter((i) => i.kind !== 'pill'),
      'center'
    );
    setLayerToasts(
      'agent-pill',
      0,
      items.filter((i) => i.kind === 'pill'),
      'top'
    );
    return () => {
      setLayerToasts('agent-toast', 0, [], 'center');
      setLayerToasts('agent-pill', 0, [], 'top');
    };
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
        className="hy-toast-agent-pill"
        // position stays inline: the web-pane-occluders test counts it per file
        style={{position: 'fixed'}}
      >
        <span className="hy-toast-agent-pill-emoji">🤖</span>
        <span>{pillText(expired)}</span>
      </div>
    );
  }
  return (
    <div className="hy-toast-agent-stack" style={{position: 'fixed'}}>
      {reqs.map((r) => (
        // The card is no-drag (see agent-toast.css): it sits in the window's drag strip.
        <div key={r.id} className="hy-toast-agent-card">
          <div className="hy-toast-agent-head">
            <span className="hy-toast-agent-emoji">🤖</span>
            <span>
              <b>{r.requesterName || r.requester}</b>
              <span className="hy-toast-agent-muted"> wants to {actionPhrase(r.action)}.</span>
            </span>
          </div>
          <div className="hy-toast-agent-actions">
            <button
              type="button"
              className="hy-toast-agent-btn hy-toast-agent-btn--deny"
              onClick={() => respond(r.id, DECISIONS.deny)}
            >
              Deny
            </button>
            <button type="button" className="hy-toast-agent-btn" onClick={() => respond(r.id, DECISIONS.once)}>
              Just once
            </button>
            <button type="button" className="hy-toast-agent-btn" onClick={() => respond(r.id, DECISIONS['15m'])}>
              15 min
            </button>
            <button type="button" className="hy-toast-agent-btn" onClick={() => respond(r.id, DECISIONS['1h'])}>
              1 hour
            </button>
            <button
              type="button"
              className="hy-toast-agent-btn hy-toast-agent-btn--allow"
              onClick={() => respond(r.id, DECISIONS.always)}
            >
              Always
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
