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
import {onToastLayerAction, setLayerToasts, useToastLayer} from '../toast-layer';
import {consentSubject, consentTargetName, consentVariant} from '../utils/consent-variant';
import {useSuppressWebPanes} from '../utils/web-pane-suppress';

import './consent-modal.css';

const CONSENT_PILL_ID = 'consent-modal-pill';

function pillText(expiredReqs: PermRequest[]): string {
  const first = expiredReqs[0];
  return expiredReqs.length === 1
    ? `${first.requesterName || first.requester} is waiting for approval — click to review`
    : `${expiredReqs.length} agents waiting for approval — click to review`;
}

// Segmented-control pill class (scope + duration rows); styles in consent-modal.css.
const segClass = (active: boolean): string => (active ? 'hy-consent-seg hy-consent-seg--active' : 'hy-consent-seg');

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
  useSuppressWebPanes(hasPrompt, 'consent-modal');

  // The collapsed "waiting" pill has no suppression of its own, so it used to
  // vanish behind any web pane at the top of the window (#297). With the native
  // toast layer it is drawn above web panes, over the live page; the DOM pill
  // below is only the fallback.
  const layer = useToastLayer();
  const showPill = !hasPrompt && expiredReqs.length > 0;
  React.useEffect(() => {
    if (!layer) return undefined;
    setLayerToasts(
      'consent-pill',
      1,
      showPill
        ? [{id: CONSENT_PILL_ID, kind: 'pill', emoji: '🛂', text: pillText(expiredReqs), title: 'Click to review'}]
        : []
    );
    return () => setLayerToasts('consent-pill', 1, []);
  }, [layer, showPill, expiredReqs]);
  React.useEffect(() => {
    if (!layer) return undefined;
    return onToastLayerAction(({toastId}) => {
      const first = expiredReqs[0];
      if (toastId === CONSENT_PILL_ID && first) reviveRequest(first.targetPane, first.id);
    });
  }, [layer, expiredReqs]);

  // Resolve the friendly "where": the recipient agent for messaging, else the
  // target pane's name from the store (see consentTargetName).
  const paneName = useSelector((s: any) => {
    if (!req) return '';
    const sess = s?.sessions?.sessions?.[req.targetPane];
    return consentTargetName(req, (sess && (sess.shellName || sess.title)) || undefined);
  });
  // The pane you're in never flashes, so the prompt mustn't say it does.
  const targetIsHere = useSelector((s: any) => !!req && s?.ui?.activeUid === req.targetPane);

  // No ACTIVE prompt — but pending (expired/snoozed) requests collapse into a
  // persistent pill instead of vanishing. Click re-opens the full prompt. The
  // request also re-opens by itself when the agent re-asks or retries the
  // gated action (the sidecar re-notifies → setRequest revives it).
  if (!req) {
    if (expiredReqs.length === 0 || layer) return null;
    const first = expiredReqs[0];
    return (
      <div
        onClick={() => reviveRequest(first.targetPane, first.id)}
        title="Click to review"
        className="hy-consent-pill"
        // position stays inline: the web-pane-occluders test counts it per file
        style={{position: 'fixed'}}
      >
        <span className="hy-consent-pill-emoji">🛂</span>
        <span>{pillText(expiredReqs)}</span>
      </div>
    );
  }

  // Wording + which rows apply (pane access / messaging / mailbox binding).
  const variant = consentVariant(req.action, targetIsHere);
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
      className="hy-consent-backdrop"
      style={{position: 'fixed'}}
      // Backdrop click SNOOZES to the pill — it must NOT silently DENY: a stray
      // click anywhere in the window was killing agents' requests (and while
      // the prompt was up, this full-window layer ate every hover/click — the
      // "all the icons are broken" reports). Only the explicit buttons decide.
      onClick={() => expireRequest(req.targetPane, req.id)}
    >
      <div onClick={(e) => e.stopPropagation()} className="hy-consent-card">
        {/* Who + what + where */}
        <div className="hy-consent-head">
          <span className="hy-consent-head-emoji">🛂</span>
          <div className="hy-consent-head-text">
            <b>{req.requesterName || req.requester}</b>
            <span className="hy-consent-muted">{variant.verb}</span>
            <b>{paneName}</b>
            <span className="hy-consent-muted"> {variant.tail}</span>
            {subject || req.purpose ? (
              <div className="hy-consent-why">
                {/* Messaging shows the mail's subject (never its body) in place of Why. */}
                {subject ? (
                  <span title={subject.full} className="hy-consent-subject">
                    <span className="hy-consent-why-label">Subject:</span> {subject.text}
                  </span>
                ) : (
                  <>
                    <span className="hy-consent-why-label">Why:</span> {req.purpose}
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>

        {/* Access — every variant uses the same label-column row. Messaging and
            binding have one possible scope, shown as a fixed chip. */}
        <div
          role="group"
          aria-label="Access"
          className={variant.showDuration ? 'hy-consent-row' : 'hy-consent-row hy-consent-row--last'}
        >
          <span className="hy-consent-row-label" aria-hidden="true">
            Access
          </span>
          <div className="hy-consent-seg-group">
            {variant.accessChip ? (
              <span
                className="hy-consent-seg hy-consent-seg--active hy-consent-seg--fixed"
                title="The only scope this request can have"
              >
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
                  className={segClass(scope === val)}
                >
                  {lbl}
                </button>
              ))
            )}
          </div>
        </div>

        {variant.showDuration ? (
          <div role="group" aria-label="For" className="hy-consent-row hy-consent-row--last">
            <span className="hy-consent-row-label" aria-hidden="true">
              For
            </span>
            <div className="hy-consent-seg-group">
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
                  className={segClass(duration === secs)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="hy-consent-error">
            {error}
          </div>
        ) : null}

        {/* Actions */}
        <div className="hy-consent-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => act('deny')}
            className={busy ? 'hy-consent-action hy-consent-action--busy' : 'hy-consent-action'}
          >
            Deny
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => act('allow')}
            className={
              busy
                ? 'hy-consent-action hy-consent-action--primary hy-consent-action--busy'
                : 'hy-consent-action hy-consent-action--primary'
            }
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
