import React, {useCallback, useEffect, useRef, useState} from 'react';

import {useStore} from 'react-redux';

import type {HyperState} from '../../typings/hyper';
import rpc from '../rpc';
import {serializeLayoutState} from '../utils/layout-serialize';
import {
  clearTabAutosave,
  getTabAutosave,
  setTabAutosave,
  startTabAutosave,
  autosaveSignature,
  TAB_AUTOSAVED_EVENT
} from '../utils/tab-autosave';
import type {ApprovedResume} from '../utils/tab-autosave';
import {useSuppressWebPanes} from '../utils/web-pane-suppress';
import {
  filterLayoutToTab,
  resumeCandidatesForTab,
  applyResumeSelections,
  n8ResumeCommand
} from '../utils/workspace-tab';
import type {ResumeCandidate} from '../utils/workspace-tab';

import PaneCountBadge from './pane-count-badge';
import {activeTerminals} from './term';

import './workspace-save-toast.css';

/**
 * The "Save Workspace" confirm for a tab (#183), styled after the
 * agent/approval toast: name (pre-filled with the tab name) plus the
 * resume-once command checklist. Opened by the tab context menu via a window
 * CustomEvent — same decoupling the consent surfaces use — and closed on
 * save/cancel/Escape. Commands listed here come ONLY from trustworthy
 * sources (n8 session bindings, shell-integration reports); checking one is
 * the human consent that lets restore execute it once.
 */

export const OPEN_SAVE_TAB_WORKSPACE_EVENT = 'hyperia-save-tab-workspace';

type OpenDetail = {rootUid: string; defaultName: string};

// Small pill after the pane name: red when the n8 resume will run with --danger.
const dangerToggleClass = (on: boolean, enabled: boolean): string =>
  ['hy-toast-save-danger', on && 'hy-toast-save-danger--on', enabled && 'hy-toast-save-danger--enabled']
    .filter(Boolean)
    .join(' ');

const WorkspaceSaveToast: React.FC = () => {
  const store = useStore<HyperState>();
  const [open, setOpen] = useState<OpenDetail | null>(null);
  const [name, setName] = useState('');
  const [candidates, setCandidates] = useState<ResumeCandidate[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  // Per-n8-row --danger toggle, seeded from how the pane was launched.
  const [danger, setDanger] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // Keep re-saving this tab under its name for the rest of the session.
  const [autosave, setAutosave] = useState(false);
  // What the in-flight save will bind if it succeeds.
  const pendingRef = useRef<{
    rootUid: string;
    name: string;
    approved: ApprovedResume[];
    json: string;
    autosave: boolean;
  } | null>(null);
  // Previously saved tab-workspaces, newest first — listed under the name
  // field so a click prefills it (and flips straight to the Overwrite flow).
  const [existing, setExisting] = useState<Array<{name: string; savedAt: string; panes: number; webPanes: number}>>([]);
  // The captured tab layout, frozen at open time so what you see is what saves.
  const layoutRef = useRef<Record<string, any> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenDetail>).detail;
      const state = store.getState();
      const full = serializeLayoutState(state, (uid) => activeTerminals.get(uid)?.getCurrentCommandLine());
      const tab = filterLayoutToTab(full as any, detail.rootUid);
      if (!tab) {
        return;
      }
      const cands = resumeCandidatesForTab(tab, state.sessions.sessions as any);
      layoutRef.current = tab;
      setCandidates(cands);
      setChecked(Object.fromEntries(cands.map((c) => [c.sessionUid, c.preChecked])));
      setDanger(Object.fromEntries(cands.map((c) => [c.sessionUid, !!c.danger])));
      setName(detail.defaultName);
      setError(null);
      setConflict(false);
      setBusy(false);
      setAutosave(!!getTabAutosave(detail.rootUid));
      setOpen(detail);
      try {
        rpc.emit('list tab workspaces');
      } catch {
        /* rpc not ready — the list simply stays empty */
      }
      setTimeout(() => inputRef.current?.select(), 0);
    };
    window.addEventListener(OPEN_SAVE_TAB_WORKSPACE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SAVE_TAB_WORKSPACE_EVENT, onOpen);
  }, [store]);

  // Native web panes paint ABOVE the renderer DOM, so this fixed card would sit
  // behind any web pane in the tab. Pull the window's web panes off-screen while
  // the toast is open (same suppression the close-confirm modal uses); restore
  // on close/unmount.
  useSuppressWebPanes(!!open, 'save-tab');

  useEffect(() => {
    const onList = ({rows}: {rows: Array<{name: string; savedAt: string; panes: number; webPanes: number}>}) => {
      setExisting(rows || []);
    };
    rpc.on('tab workspaces list', onList);
    return () => {
      rpc.removeListener('tab workspaces list', onList);
    };
  }, []);

  useEffect(() => startTabAutosave(store, (uid) => activeTerminals.get(uid)?.getCurrentCommandLine()), [store]);

  useEffect(() => {
    const onResult = (res: {ok: boolean; name: string; error?: string; conflict?: boolean; autosave?: boolean}) => {
      // Background autosave writes share this channel; they're not ours.
      if (res.autosave) {
        return;
      }
      setBusy(false);
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (res.ok) {
        if (pending) {
          if (pending.autosave) {
            setTabAutosave(pending.rootUid, {name: pending.name, approved: pending.approved, lastSaved: pending.json});
          } else {
            clearTabAutosave(pending.rootUid);
          }
          // Confirm the save on the tab itself: same top-line pulse as an autosave.
          window.dispatchEvent(new CustomEvent(TAB_AUTOSAVED_EVENT, {detail: {rootUid: pending.rootUid}}));
        }
        setOpen(null);
      } else {
        setConflict(!!res.conflict);
        setError(res.conflict ? null : res.error || 'save failed');
      }
    };
    rpc.on('save tab workspace result', onResult);
    return () => {
      rpc.removeListener('save tab workspace result', onResult);
    };
  }, []);

  const commandFor = useCallback(
    (c: ResumeCandidate) => (c.source === 'n8' ? n8ResumeCommand(c.command, !!danger[c.sessionUid]) : c.command),
    [danger]
  );

  const save = useCallback(
    (overwrite: boolean) => {
      if (!layoutRef.current || !name.trim()) {
        return;
      }
      const selections = candidates
        .filter((c) => checked[c.sessionUid])
        .map((c) => ({sessionUid: c.sessionUid, command: commandFor(c), source: c.source}));
      const layout = applyResumeSelections(layoutRef.current as any, selections);
      setBusy(true);
      setError(null);
      if (open) {
        pendingRef.current = {
          rootUid: open.rootUid,
          name: name.trim(),
          approved: selections,
          json: autosaveSignature(layout as any),
          autosave
        };
      }
      rpc.emit('save tab workspace', {name: name.trim(), overwrite, layout});
    },
    [name, candidates, checked, commandFor, open, autosave]
  );

  if (!open) {
    return null;
  }

  return (
    <div
      className="hy-toast-save-card"
      // position stays inline: the web-pane-occluders test counts it per file
      style={{position: 'fixed'}}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(null)}
    >
      <div className="hy-toast-save-title">Save Tab</div>
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setConflict(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save(conflict);
          e.stopPropagation();
        }}
        className="hy-toast-save-name"
      />
      {existing.length > 0 && (
        <div className="hy-toast-save-section">
          <div className="hy-toast-save-label">Or overwrite a saved tab:</div>
          <div className="hy-toast-save-existing">
            {existing.map((ws) => {
              const selected = ws.name === name.trim();
              const total = ws.panes + ws.webPanes;
              return (
                <div
                  key={ws.name}
                  onClick={() => {
                    setName(ws.name);
                    setConflict(true);
                    setError(null);
                    inputRef.current?.focus();
                  }}
                  title={`Overwrite “${ws.name}” · ${total} pane${total === 1 ? '' : 's'}${
                    ws.webPanes ? ` (${ws.webPanes} web)` : ''
                  }`}
                  className={selected ? 'hy-toast-save-row hy-toast-save-row--selected' : 'hy-toast-save-row'}
                >
                  <span className="hy-toast-save-row-name">{ws.name}</span>
                  <PaneCountBadge count={total} webPanes={ws.webPanes} />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {candidates.length > 0 && (
        <div className="hy-toast-save-section hy-toast-save-section--resume">
          <div className="hy-toast-save-label">Will resume on restore (checked commands run once):</div>
          {candidates.map((c) => (
            <label key={c.sessionUid} className="hy-toast-save-cand">
              <input
                type="checkbox"
                checked={!!checked[c.sessionUid]}
                onChange={(e) => setChecked({...checked, [c.sessionUid]: e.target.checked})}
              />
              <span className="hy-toast-save-cand-label">{c.label}</span>
              {c.source === 'n8' && (
                <button
                  type="button"
                  aria-pressed={!!danger[c.sessionUid]}
                  disabled={!checked[c.sessionUid]}
                  title={
                    danger[c.sessionUid]
                      ? 'Resumes with --danger (no approvals, no sandbox). Click to turn off.'
                      : 'Click to resume with --danger (no approvals, no sandbox).'
                  }
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDanger({...danger, [c.sessionUid]: !danger[c.sessionUid]});
                  }}
                  className={dangerToggleClass(!!danger[c.sessionUid], !!checked[c.sessionUid])}
                >
                  danger
                </button>
              )}
              <span className="hy-toast-save-cmd" title={commandFor(c)}>
                {commandFor(c)}
              </span>
              {c.source === 'n8' && <span className="hy-toast-save-n8">n8</span>}
            </label>
          ))}
        </div>
      )}
      <label
        className="hy-toast-save-autosave"
        title="Re-save this tab under the same name whenever it changes, until it's closed or Hyperia quits"
      >
        <input type="checkbox" checked={autosave} onChange={(e) => setAutosave(e.target.checked)} />
        <span>Autosave changes to this tab for the rest of the session</span>
      </label>
      {conflict && (
        <div className="hy-toast-save-conflict">A saved tab named “{name.trim()}” exists — overwrite it?</div>
      )}
      {error && <div className="hy-toast-save-error">{error}</div>}
      <div className="hy-toast-save-actions">
        <button type="button" className="hy-toast-save-btn" onClick={() => setOpen(null)}>
          Cancel
        </button>
        <button
          type="button"
          className="hy-toast-save-btn hy-toast-save-btn--primary"
          disabled={busy || !name.trim()}
          onClick={() => save(conflict)}
        >
          {busy ? 'Saving…' : conflict ? 'Overwrite' : 'Save'}
        </button>
      </div>
    </div>
  );
};

export default WorkspaceSaveToast;
