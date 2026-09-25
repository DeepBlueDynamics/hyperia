import {ipcRenderer} from 'electron';
import React from 'react';

import {useSelector} from 'react-redux';

import {
  subscribeAllRequests,
  subscribeExpiredRequests,
  clearRequest,
  expireRequest,
  reviveRequest,
  type PermRequest
} from '../permissions-bus';
import {consentSubject, consentTargetName, consentVariant} from '../utils/consent-variant';

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

// The same pill, frozen: messaging/binding have exactly one possible scope, so
// it's shown as a fixed chip — not a button, no hover, no pointer.
const fixedChipStyle: React.CSSProperties = {
  ...segStyle(true),
  display: 'inline-block',
  lineHeight: 'normal',
  cursor: 'default',
  userSelect: 'none'
};

// Row: muted 54px label column + controls. Shared by Access and For so every
// variant lines up the same way.
const rowStyle = (last: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  marginBottom: last ? '18px' : '10px'
});
const rowLabelStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-secondary, #9a9aa2)',
  width: '54px',
  flexShrink: 0
};

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

async function respond(
  req: PermRequest,
  decision: 'allow' | 'deny',
  scope: 'pane' | 'tab' | 'any',
  durationSecs: number | null
): Promise<void> {
  const result = await ipcRenderer.invoke('consent:respond', {id: req.id, decision, scope, durationSecs});
  // Gone sidecar-side (expired or already answered): close, don't show a retry error.
  if (result?.gone) {
    clearRequest(req.targetPane, req.id);
    return;
  }
  if (!result?.ok) throw new Error(result?.error || 'Approval was not recorded. Please retry.');
  clearRequest(req.targetPane, req.id);
}

/**
 * Window-level, centered cross-pane consent prompt. Replaces the old per-pane
 * card that hid inside a single pane's band — this one is reachable no matter
 * which tab you're on, and the owning tab still flashes + shows a 🔔 so you know
 * WHERE it's going. Approving here flushes the agent's held command to that pane.
 */
export default function ConsentModal(): React.ReactElement | null {
  const [reqs, setReqs] = React.useState<PermRequest[]>([]);
  const [expiredReqs, setExpiredReqs] = React.useState<PermRequest[]>([]);
  React.useEffect(() => subscribeAllRequests(setReqs), []);
  React.useEffect(() => subscribeExpiredRequests(setExpiredReqs), []);

  const req = reqs[0] || null;

  const [scope, setScope] = React.useState<'pane' | 'tab' | 'any'>('pane');
  const [duration, setDuration] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  // Reset choices to friendly defaults whenever a new prompt opens.
  React.useEffect(() => {
    setScope('pane');
    setDuration(null);
    setBusy(false);
    setError('');
  }, [req?.id]);

  // Native web panes paint above the DOM, so this full-window prompt would sit
  // BEHIND a web pane — the "ACL prompt I can't see" bug. While the full prompt
  // is up, pull the window's web panes off-screen (frozen-still, no blank) so it
  // renders on top; restore on close. Only for the full modal, not the pill.
  const hasPrompt = !!req;
  React.useEffect(() => {
    if (!hasPrompt) return undefined;
    ipcRenderer.send('web-panes:suppress', {suppressed: true});
    return () => ipcRenderer.send('web-panes:suppress', {suppressed: false});
  }, [hasPrompt]);

  // Resolve the friendly "where": the recipient agent for messaging, else the
  // target pane's name from the store (see consentTargetName).
  const paneName = useSelector((s: any) => {
    if (!req) return '';
    const sess = s?.sessions?.sessions?.[req.targetPane];
    return consentTargetName(req, (sess && (sess.shellName || sess.title)) || undefined);
  });

  // No ACTIVE prompt — but pending (expired/snoozed) requests collapse into a
  // persistent pill instead of vanishing. Click re-opens the full prompt. The
  // request also re-opens by itself when the agent re-asks or retries the
  // gated action (the sidecar re-notifies → setRequest revives it).
  if (!req) {
    if (expiredReqs.length === 0) return null;
    const first = expiredReqs[0];
    return (
      <div
        onClick={() => reviveRequest(first.targetPane, first.id)}
        title="Click to review"
        style={{
          position: 'fixed',
          top: '10px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 99998,
          // The pill parks INSIDE the frameless window's drag strip — without
          // no-drag, clicks start a WINDOW DRAG instead of dispatching DOM
          // events, so "click to review" did nothing.
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
          animation: 'hyConsentPill 2.4s ease-in-out infinite'
        }}
      >
        <style>{`@keyframes hyConsentPill{0%,100%{box-shadow:0 6px 20px rgba(0,0,0,0.45)}50%{box-shadow:0 0 14px 2px var(--accent-primary, #6ea8fe)}}`}</style>
        <span style={{fontSize: '14px', lineHeight: 1}}>🛂</span>
        <span>
          {expiredReqs.length === 1
            ? `${first.requesterName || first.requester} is waiting for approval — click to review`
            : `${expiredReqs.length} agents waiting for approval — click to review`}
        </span>
      </div>
    );
  }

  // Wording + which rows apply (pane access / messaging / mailbox binding).
  const variant = consentVariant(req.action);
  const subject = consentSubject(req);

  const act = (decision: 'allow' | 'deny') => {
    setBusy(true);
    setError('');
    void respond(req, decision, scope, duration).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Approval was not recorded. Please retry.');
      setBusy(false);
    });
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
      // Backdrop click SNOOZES to the pill — it must NOT silently DENY: a stray
      // click anywhere in the window was killing agents' requests (and while
      // the prompt was up, this full-window layer ate every hover/click — the
      // "all the icons are broken" reports). Only the explicit buttons decide.
      onClick={() => expireRequest(req.targetPane, req.id)}
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
            <b>{req.requesterName || req.requester}</b>
            <span style={{color: 'var(--text-secondary, #9a9aa2)'}}>{variant.verb}</span>
            <b>{paneName}</b>
            <span style={{color: 'var(--text-secondary, #9a9aa2)'}}> {variant.tail}</span>
            {subject || req.purpose ? (
              <div
                style={{
                  marginTop: '8px',
                  padding: '6px 9px',
                  borderLeft: '2px solid var(--accent-primary, #6ea8fe)',
                  background: 'var(--bg-secondary, rgba(255,255,255,0.04))',
                  borderRadius: '3px',
                  fontSize: '12.5px',
                  color: 'var(--text-secondary, #9a9aa2)'
                }}
              >
                {/* Messaging shows the mail's subject (never its body) in place of Why. */}
                {subject ? (
                  <span title={subject.full} style={{overflowWrap: 'anywhere'}}>
                    <span style={{color: 'var(--text-primary, #e8e8ea)'}}>Subject:</span> {subject.text}
                  </span>
                ) : (
                  <>
                    <span style={{color: 'var(--text-primary, #e8e8ea)'}}>Why:</span> {req.purpose}
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>

        {/* Access — every variant uses the same label-column row. Messaging and
            binding have one possible scope, shown as a fixed chip. */}
        <div role="group" aria-label="Access" style={rowStyle(!variant.showDuration)}>
          <span style={rowLabelStyle} aria-hidden="true">
            Access
          </span>
          <div style={{display: 'flex', gap: '5px'}}>
            {variant.accessChip ? (
              <span style={fixedChipStyle} title="The only scope this request can have">
                {variant.accessChip}
              </span>
            ) : (
              (
                [
                  ['pane', 'This pane'],
                  ['tab', 'This tab'],
                  ['any', 'Any pane']
                ] as const
              ).map(([val, lbl]) => (
                <button
                  key={val}
                  type="button"
                  aria-pressed={scope === val}
                  onClick={() => setScope(val)}
                  style={segStyle(scope === val)}
                >
                  {lbl}
                </button>
              ))
            )}
          </div>
        </div>

        {variant.showDuration ? (
          <div role="group" aria-label="For" style={rowStyle(true)}>
            <span style={rowLabelStyle} aria-hidden="true">
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
                <button
                  key={lbl}
                  type="button"
                  aria-pressed={duration === secs}
                  onClick={() => setDuration(secs)}
                  style={segStyle(duration === secs)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {error ? (
          <div role="alert" style={{color: 'var(--accent-danger, #f85149)', marginBottom: 12}}>
            {error}
          </div>
        ) : null}

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
