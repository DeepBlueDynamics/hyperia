import React from 'react';

import {subscribeToasts, clearToast, type ToastRequest} from '../permissions-bus';

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
  'cap:manage': 'close / manage panes & tabs'
};
function actionPhrase(action: string): string {
  return CREATE_SURFACE[action] || CAP_PHRASE[action] || 'perform an action';
}

function respond(id: string, body: Record<string, unknown>): void {
  const port = (process.env.HYPERIA_PORT as string) || '9800';
  fetch(`http://localhost:${port}/api/perms/respond`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({id, action: 'create', ...body})
  })
    .catch((err) => console.error('create-consent respond failed:', err))
    .finally(() => clearToast(id));
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
export default function AgentToast(): React.ReactElement | null {
  const [reqs, setReqs] = React.useState<ToastRequest[]>([]);
  React.useEffect(() => subscribeToasts(setReqs), []);
  if (!reqs.length) return null;
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
          <div style={{display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '12.5px', lineHeight: 1.35}}>
            <span style={{fontSize: '15px'}}>🤖</span>
            <span>
              <b>{r.requester}</b>
              <span style={{color: 'var(--text-secondary, #9a9aa2)'}}> wants to {actionPhrase(r.action)}.</span>
            </span>
          </div>
          <div style={{display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap'}}>
            <button type="button" style={denyBtn} onClick={() => respond(r.id, {decision: 'deny'})}>
              Deny
            </button>
            <button type="button" style={btn} onClick={() => respond(r.id, {decision: 'allow', scope: 'once'})}>
              Just once
            </button>
            <button type="button" style={btn} onClick={() => respond(r.id, {decision: 'allow', durationSecs: 900})}>
              15 min
            </button>
            <button type="button" style={btn} onClick={() => respond(r.id, {decision: 'allow', durationSecs: 3600})}>
              1 hour
            </button>
            <button type="button" style={allowBtn} onClick={() => respond(r.id, {decision: 'allow', durationSecs: null})}>
              Always
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
