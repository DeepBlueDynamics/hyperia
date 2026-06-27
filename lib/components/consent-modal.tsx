import React from 'react';
import {useSelector} from 'react-redux';

import {subscribeAllRequests, clearRequest, type PermRequest} from '../permissions-bus';

// Segmented-control pill (scope + duration rows). Mirrors the old per-pane card.
const segStyle = (active: boolean): React.CSSProperties => ({
  padding: '4px 11px',
  fontSize: '11px',
  borderRadius: '5px',
  border: '1px solid',
  borderColor: active ? 'var(--accent-primary, #6ea8fe)' : 'var(--border-neutral, rgba(255,255,255,0.12))',
  background: active ? 'var(--accent-primary, #6ea8fe)' : 'transparent',
  color: active ? '#0b0b0f' : 'var(--text-secondary, #9a9aa2)',
  fontWeight: active ? 600 : 400,
  cursor: 'pointer',
  whiteSpace: 'nowrap'
});

const actionStyle = (primary: boolean, busy: boolean): React.CSSProperties => ({
  padding: '7px 20px',
  fontSize: '13px',
  fontWeight: 600,
  borderRadius: '6px',
  border: '1px solid',
  borderColor: primary ? 'var(--accent-success, #3fb950)' : 'var(--border-neutral, rgba(255,255,255,0.15))',
  background: primary ? 'var(--accent-success, #3fb950)' : 'transparent',
  color: primary ? '#06140a' : 'var(--text-primary, #e8e8ea)',
  cursor: busy ? 'default' : 'pointer',
  opacity: busy ? 0.55 : 1
});

function respond(
  req: PermRequest,
  decision: 'allow' | 'deny',
  scope: 'pane' | 'tab' | 'any',
  durationSecs: number | null
): void {
  const port = (process.env.HYPERIA_PORT as string) || '9800';
  fetch(`http://localhost:${port}/api/perms/respond`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({id: req.id, decision, scope, durationSecs})
  })
    .catch((err) => console.error('permission respond failed:', err))
    .finally(() => clearRequest(req.targetPane));
}

/**
 * Window-level, centered cross-pane consent prompt. Replaces the old per-pane
 * card that hid inside a single pane's band — this one is reachable no matter
 * which tab you're on, and the owning tab still flashes + shows a 🔔 so you know
 * WHERE it's going. Approving here flushes the agent's held command to that pane.
 */
export default function ConsentModal(): React.ReactElement | null {
  const [reqs, setReqs] = React.useState<PermRequest[]>([]);
  React.useEffect(() => subscribeAllRequests(setReqs), []);

  const req = reqs[0] || null;

  const [scope, setScope] = React.useState<'pane' | 'tab' | 'any'>('pane');
  const [duration, setDuration] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Reset choices to friendly defaults whenever a new prompt opens.
  React.useEffect(() => {
    setScope('pane');
    setDuration(null);
    setBusy(false);
  }, [req?.id]);

  // Resolve the target pane's friendly name (the "where") from the store.
  const paneName = useSelector((s: any) => {
    const sess = req ? s?.sessions?.sessions?.[req.targetPane] : null;
    return (sess && (sess.shellName || sess.title)) || (req ? `pane ${req.targetPane.slice(0, 8)}` : '');
  });

  if (!req) return null;

  const act = (decision: 'allow' | 'deny') => {
    setBusy(true);
    respond(req, decision, scope, duration);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(1.5px)',
        animation: 'hyConsentBg 140ms ease'
      }}
      onClick={() => act('deny')}
    >
      <style>{`
        @keyframes hyConsentBg{from{opacity:0}to{opacity:1}}
        @keyframes hyConsentIn{from{opacity:0;transform:translateY(-10px) scale(0.98)}to{opacity:1;transform:translateY(0) scale(1)}}
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(420px, calc(100vw - 32px))',
          boxSizing: 'border-box',
          padding: '18px 20px',
          background: 'var(--bg-elevated, var(--bg-secondary, #1c1c22))',
          border: '1px solid var(--accent-primary, #6ea8fe)',
          borderRadius: '12px',
          boxShadow: '0 18px 50px rgba(0,0,0,0.6)',
          color: 'var(--text-primary, #e8e8ea)',
          fontFamily: 'var(--font-sans)',
          animation: 'hyConsentIn 160ms ease'
        }}
      >
        {/* Who + what + where */}
        <div style={{display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '16px'}}>
          <span style={{fontSize: '20px', lineHeight: 1}}>🛂</span>
          <div style={{fontSize: '13.5px', lineHeight: 1.4}}>
            <b>{req.requester}</b>
            <span style={{color: 'var(--text-secondary, #9a9aa2)'}}> wants to control </span>
            <b>{paneName}</b>
            <span style={{color: 'var(--text-secondary, #9a9aa2)'}}>
              {' '}— its tab is flashing 🔔. Approving runs the command it’s holding.
            </span>
          </div>
        </div>

        {/* Scope */}
        <div style={{display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px'}}>
          <span style={{fontSize: '11px', color: 'var(--text-secondary, #9a9aa2)', width: '54px', flexShrink: 0}}>
            Access
          </span>
          <div style={{display: 'flex', gap: '5px'}}>
            {(
              [
                ['pane', 'This pane'],
                ['tab', 'This tab'],
                ['any', 'Any pane']
              ] as const
            ).map(([val, lbl]) => (
              <button key={val} type="button" onClick={() => setScope(val)} style={segStyle(scope === val)}>
                {lbl}
              </button>
            ))}
          </div>
        </div>

        {/* Duration */}
        <div style={{display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px'}}>
          <span style={{fontSize: '11px', color: 'var(--text-secondary, #9a9aa2)', width: '54px', flexShrink: 0}}>
            For
          </span>
          <div style={{display: 'flex', gap: '5px'}}>
            {(
              [
                ['15 min', 900],
                ['1 hour', 3600],
                ['Always', null]
              ] as const
            ).map(([lbl, secs]) => (
              <button key={lbl} type="button" onClick={() => setDuration(secs)} style={segStyle(duration === secs)}>
                {lbl}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={{display: 'flex', gap: '10px', justifyContent: 'flex-end'}}>
          <button type="button" disabled={busy} onClick={() => act('deny')} style={actionStyle(false, busy)}>
            Deny
          </button>
          <button type="button" disabled={busy} onClick={() => act('allow')} style={actionStyle(true, busy)}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
