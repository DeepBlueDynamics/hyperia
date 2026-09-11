import React, {useCallback, useEffect, useRef, useState} from 'react';

import {useStore} from 'react-redux';

import type {HyperState} from '../../typings/hyper';
import rpc from '../rpc';
import {serializeLayoutState} from '../utils/layout-serialize';
import {filterLayoutToTab, resumeCandidatesForTab, applyResumeSelections} from '../utils/workspace-tab';
import type {ResumeCandidate} from '../utils/workspace-tab';

import {activeTerminals} from './term';

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

const cardStyle: React.CSSProperties = {
  position: 'fixed',
  top: 44,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 1200,
  background: 'var(--bg-primary)',
  border: '0.5px solid var(--border-neutral)',
  borderRadius: 'var(--radius-6, 8px)',
  padding: '12px 14px',
  minWidth: '340px',
  maxWidth: 'min(520px, 90vw)',
  boxShadow: '0 8px 28px rgba(0, 0, 0, 0.35)',
  fontFamily: 'var(--font-sans)',
  fontSize: '12px',
  color: 'var(--text-primary)'
};

const btnStyle = (primary: boolean): React.CSSProperties => ({
  padding: '5px 14px',
  fontSize: '12px',
  fontWeight: 600,
  borderRadius: '6px',
  border: '1px solid',
  borderColor: primary ? 'var(--accent-success, #3fb950)' : 'var(--border-neutral, rgba(255,255,255,0.15))',
  background: primary ? 'var(--accent-success, #3fb950)' : 'transparent',
  color: primary ? '#06140a' : 'var(--text-primary)',
  cursor: 'pointer'
});

const WorkspaceSaveToast: React.FC = () => {
  const store = useStore<HyperState>();
  const [open, setOpen] = useState<OpenDetail | null>(null);
  const [name, setName] = useState('');
  const [candidates, setCandidates] = useState<ResumeCandidate[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
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
      setName(detail.defaultName);
      setError(null);
      setConflict(false);
      setBusy(false);
      setOpen(detail);
      setTimeout(() => inputRef.current?.select(), 0);
    };
    window.addEventListener(OPEN_SAVE_TAB_WORKSPACE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SAVE_TAB_WORKSPACE_EVENT, onOpen);
  }, [store]);

  useEffect(() => {
    const onResult = (res: {ok: boolean; name: string; error?: string; conflict?: boolean}) => {
      setBusy(false);
      if (res.ok) {
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

  const save = useCallback(
    (overwrite: boolean) => {
      if (!layoutRef.current || !name.trim()) {
        return;
      }
      const selections = candidates
        .filter((c) => checked[c.sessionUid])
        .map((c) => ({sessionUid: c.sessionUid, command: c.command, source: c.source}));
      const layout = applyResumeSelections(layoutRef.current as any, selections);
      setBusy(true);
      setError(null);
      rpc.emit('save tab workspace', {name: name.trim(), overwrite, layout});
    },
    [name, candidates, checked]
  );

  if (!open) {
    return null;
  }

  return (
    <div style={cardStyle} onKeyDown={(e) => e.key === 'Escape' && setOpen(null)}>
      <div style={{fontWeight: 600, marginBottom: '8px'}}>Save tab as workspace</div>
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
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '5px 8px',
          fontSize: '12px',
          fontFamily: 'var(--font-sans)',
          background: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-neutral)',
          borderRadius: '5px',
          outline: 'none'
        }}
      />
      {candidates.length > 0 && (
        <div style={{marginTop: '10px'}}>
          <div style={{color: 'var(--text-secondary)', marginBottom: '4px'}}>
            Will resume on restore (checked commands run once):
          </div>
          {candidates.map((c) => (
            <label
              key={c.sessionUid}
              style={{display: 'flex', alignItems: 'baseline', gap: '6px', padding: '2px 0', cursor: 'pointer'}}
            >
              <input
                type="checkbox"
                checked={!!checked[c.sessionUid]}
                onChange={(e) => setChecked({...checked, [c.sessionUid]: e.target.checked})}
              />
              <span style={{color: 'var(--text-secondary)', flexShrink: 0}}>{c.label}</span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
                title={c.command}
              >
                {c.command}
              </span>
              {c.source === 'n8' && <span style={{fontSize: '10px', color: 'var(--info-text)'}}>n8</span>}
            </label>
          ))}
        </div>
      )}
      {conflict && (
        <div style={{marginTop: '8px', color: 'var(--warning-text, #d9a300)'}}>
          A workspace named “{name.trim()}” exists — overwrite it?
        </div>
      )}
      {error && <div style={{marginTop: '8px', color: 'var(--danger-text, #ff5c57)'}}>{error}</div>}
      <div style={{display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px'}}>
        <button type="button" style={btnStyle(false)} onClick={() => setOpen(null)}>
          Cancel
        </button>
        <button type="button" style={btnStyle(true)} disabled={busy || !name.trim()} onClick={() => save(conflict)}>
          {busy ? 'Saving…' : conflict ? 'Overwrite' : 'Save'}
        </button>
      </div>
    </div>
  );
};

export default WorkspaceSaveToast;
