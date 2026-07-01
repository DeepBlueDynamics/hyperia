import React from 'react';
import {ipcRenderer} from 'electron';

// Pulse picker pills + action buttons (re-poke watchdog editor in the band).
const pulseSeg = (active: boolean): React.CSSProperties => ({
  padding: '3px 9px',
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
const pulseBtn = (primary: boolean, busy: boolean): React.CSSProperties => ({
  padding: '5px 14px',
  fontSize: '12px',
  fontWeight: 600,
  borderRadius: '6px',
  border: '1px solid',
  borderColor: primary ? 'var(--accent-primary, #6ea8fe)' : 'var(--border-neutral, rgba(255,255,255,0.15))',
  background: primary ? 'var(--accent-primary, #6ea8fe)' : 'transparent',
  color: primary ? '#0b0b0f' : 'var(--text-primary, #e8e8ea)',
  cursor: busy ? 'default' : 'pointer',
  opacity: busy ? 0.55 : 1
});

type PaneBandProps = {
  paneType: 'shell' | 'web' | 'ai';
  tint?: 'success' | 'info' | 'warning' | 'danger' | 'ai' | 'neutral';
  label: string | React.ReactNode;
  icon?: React.ReactNode;
  profileChip?: React.ReactNode;
  isPlaceholder?: boolean; // italic label + neutral tint
  navCluster?: React.ReactNode; // back/forward (+ refresh for web)
  locationBar?: React.ReactNode; // path bar, URL bar, or null
  onSplitRight: () => void;
  onSplitDown: () => void;
  onSplitLeft?: () => void;
  onSplitUp?: () => void;
  onClose: () => void;
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  height?: 'normal' | 'compact'; // maps to var(--band-height) | var(--band-height-compact)
  isSplitRightDisabled?: boolean;
  isSplitDownDisabled?: boolean;
  paneName?: string; // Optional override for the visible name used in click-to-copy
  paneId?: string; // Underlying UID — used ONLY to append a short suffix to the copied string for disambiguation
  isBusy?: boolean;
};

const getTextFromNode = (node: React.ReactNode): string => {
  if (!node) return '';
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(getTextFromNode).join('');
  }
  if (React.isValidElement(node)) {
    const props = node.props;
    if (props) {
      if (props.className === 'term_labelFull') {
        return getTextFromNode(props.children);
      }
      if (props.className === 'term_labelShort') {
        return ''; // Skip short version to prevent duplication
      }
      if (props.children !== undefined) {
        return getTextFromNode(props.children);
      }
    }
  }
  return '';
};

import {openLayout} from '../utils/layouts';

export const PaneBand = React.forwardRef<HTMLDivElement, PaneBandProps>(
  (
    {
      paneType,
      tint = 'neutral',
      label,
      icon,
      profileChip,
      isPlaceholder = false,
      navCluster,
      locationBar,
      onSplitRight,
      onSplitDown,
      onSplitLeft,
      onSplitUp,
      onClose,
      onClick,
      onContextMenu,
      height = 'compact',
      isSplitRightDisabled = false,
      isSplitDownDisabled = false,
      paneName,
      paneId,
      isBusy = false
    },
    ref
  ) => {
    const resolvedTint = isPlaceholder ? 'neutral' : tint;
    const isAi = paneType === 'ai';

    const [confirmClose, setConfirmClose] = React.useState(false);
    const confirmCloseTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

    React.useEffect(() => {
      return () => {
        if (confirmCloseTimeoutRef.current) {
          clearTimeout(confirmCloseTimeoutRef.current);
        }
      };
    }, []);

    // Cross-pane access consent now renders as a single window-level centered
    // modal (lib/components/consent-modal.tsx), reachable from any tab — not a
    // per-pane card. The owning tab still flashes + shows 🔔 to say WHERE.

    const [copied, setCopied] = React.useState(false);

    React.useEffect(() => {
      if (copied) {
        const timer = setTimeout(() => {
          setCopied(false);
        }, 1000);
        return () => clearTimeout(timer);
      }
    }, [copied]);

    // ── Pulse (re-poke watchdog) editor ──────────────────────────────────────
    // The human sets a pulse via main (which holds SYSTEM_TOKEN) so it bypasses
    // the agent consent gate. We only show the active state + a compact editor.
    const [pulseOpen, setPulseOpen] = React.useState(false);
    const [pulseActive, setPulseActive] = React.useState(false);
    const [pKeys, setPKeys] = React.useState('');
    // Default to a random interval (30s–5m) so multiple pulses don't fire in
    // lockstep; the [rand] button re-rolls it.
    const [pInterval, setPInterval] = React.useState(() => 30 + Math.floor(Math.random() * 271));
    const [pIdleOnly, setPIdleOnly] = React.useState(true);
    const [pSubmit, setPSubmit] = React.useState(true);
    const [pLifetime, setPLifetime] = React.useState(3600);
    const [pBusy, setPBusy] = React.useState(false);

    // Reflect whether this pane already has an active pulse (on open + mount).
    React.useEffect(() => {
      if (!paneId) return;
      let alive = true;
      const check = () => {
        void ipcRenderer.invoke('pulse:status').then((txt: string) => {
          if (!alive) return;
          try {
            const list = (JSON.parse(txt)?.pulses || []) as Array<{pane: string; paused: boolean}>;
            setPulseActive(list.some((p) => p.pane === paneId && !p.paused));
          } catch {
            /* ignore */
          }
        });
      };
      check();
      // Poll so the running indicator stays accurate (a pulse can expire or be
      // cleared from elsewhere) — this drives the pulsing icon.
      const t = setInterval(check, 5000);
      return () => {
        alive = false;
        clearInterval(t);
      };
    }, [paneId, pulseOpen]);

    const submitPulse = React.useCallback(() => {
      if (!paneId || !pKeys.trim()) return;
      setPBusy(true);
      void ipcRenderer
        .invoke('pulse:set', {
          pane: paneId,
          keys: pKeys,
          interval_secs: pInterval,
          idle_only: pIdleOnly,
          submit: pSubmit,
          max_lifetime_secs: pLifetime
        })
        .finally(() => {
          setPBusy(false);
          setPulseActive(true);
          setPulseOpen(false);
        });
    }, [paneId, pKeys, pInterval, pIdleOnly, pLifetime]);

    const clearPulse = React.useCallback(() => {
      if (!paneId) return;
      setPBusy(true);
      void ipcRenderer.invoke('pulse:clear', {pane: paneId}).finally(() => {
        setPBusy(false);
        setPulseActive(false);
        setPulseOpen(false);
      });
    }, [paneId]);

    const handleNameClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      // Prefer the visible label text (what the user actually sees) and only
      // fall back to an explicit override or a generic placeholder. If we
      // know the underlying UID, append a short suffix so two panes with
      // the same name remain distinguishable. Shape:
      //   `<name> (pane <8charHex>)`
      // Pasting that anywhere reads as the human name first; the parenthetical
      // tells the reader (or an agent) the kind and gives a stable handle.
      const name = (paneName || getTextFromNode(label) || 'Pane').trim();
      const shortId = paneId ? paneId.replace(/-/g, '').slice(0, 8) : '';
      let cleanText = name;
      if (shortId) {
        if (paneType === 'web') {
          cleanText = `Hyperia WebPane: ${name} (${shortId})`;
        } else if (paneType === 'ai') {
          cleanText = `Hyperia AIPane: ${name} (${shortId})`;
        } else {
          cleanText = `Hyperia Pane: ${name} (${shortId})`;
        }
      }
      if (cleanText) {
        // Use Electron's clipboard, not navigator.clipboard — the latter fails
        // silently in this (non-secure-context) renderer.
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('electron').clipboard.writeText(cleanText);
        } catch (err) {
          console.error('Failed to copy pane name to clipboard:', err);
        }
        // Always flash the badge — it confirms the click registered even if the
        // clipboard write was blocked. (Previously setCopied lived inside the
        // try, so a clipboard failure left zero feedback.)
        setCopied(true);
      }
    };

    // Right-click the pane name → copy menu (name / id / access token). Built in
    // the renderer (via @electron/remote, like the tab menu) so each copy can
    // flash the same "Copied ✓" feedback.
    const handleNameContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const name = (paneName || getTextFromNode(label) || 'Pane').trim();
      const shortId = paneId ? paneId.replace(/-/g, '').slice(0, 8) : '';
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {Menu, MenuItem} = require('@electron/remote');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {clipboard} = require('electron');
        const menu = new Menu();
        menu.append(
          new MenuItem({
            label: 'Copy Pane Name',
            click: () => {
              let cleanText = name;
              if (shortId) {
                if (paneType === 'web') {
                  cleanText = `Hyperia WebPane: ${name} (${shortId})`;
                } else if (paneType === 'ai') {
                  cleanText = `Hyperia AIPane: ${name} (${shortId})`;
                } else {
                  cleanText = `Hyperia Pane: ${name} (${shortId})`;
                }
              }
              clipboard.writeText(cleanText);
              setCopied(true);
            }
          })
        );
        if (paneId) {
          menu.append(
            new MenuItem({
              label: 'Copy Pane ID',
              click: () => {
                clipboard.writeText(paneId);
                setCopied(true);
              }
            })
          );
          if (paneType === 'shell') {
            menu.append(new MenuItem({type: 'separator'}));
            menu.append(
              new MenuItem({
                label: 'Copy Pane Token + ID',
                click: () => {
                  const port = (process.env.HYPERIA_PORT as string) || '9800';
                  fetch(`http://localhost:${port}/api/perms/token?pane=${encodeURIComponent(paneId)}`)
                    .then((r) => r.json())
                    .then((d) => {
                      if (d?.token) {
                        // Hand the agent everything it needs in one paste: the
                        // pane it's identifying as + the token for its
                        // Authorization header. Name line is a human comment.
                        clipboard.writeText(`${name}\npane: ${paneId}\ntoken: ${d.token}`);
                        setCopied(true);
                      }
                    })
                    .catch((err) => console.error('copy pane token failed:', err));
                }
              })
            );
          }
        }
        menu.popup();
      } catch (err) {
        console.error('pane name context menu failed:', err);
      }
    };

    // Default fallback icons if none provided
    const resolvedIcon =
      icon !== undefined ? (
        icon
      ) : isAi ? (
        <span style={{fontSize: '12px'}}>✨</span>
      ) : paneType === 'web' ? (
        <span>🌐</span>
      ) : (
        // Terminal panes: the classic shell prompt glyph (no clean emoji exists
        // for ">_", so render it in mono so it reads as a console).
        <span style={{fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 700, opacity: 0.85}}>
          {'>_'}
        </span>
      );

    return (
      <div
        ref={ref}
        className={`pane-band-container pane-band-tint-${resolvedTint} pane-band-height-${height}`}
        onClick={onClick}
        onContextMenu={onContextMenu}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          paddingRight: 'var(--space-10)',
          flexShrink: 0,
          boxSizing: 'border-box',
          cursor: onClick ? 'pointer' : 'default',
          userSelect: 'none',
          position: 'relative'
        }}
      >
        {/* Left-justified content: name, nav, URL bar. URL bar fills the row. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-8)',
            flex: 1,
            minWidth: 0
          }}
        >
          {paneType !== 'shell' ? (
            /* Web / AI: ONE tight, left-anchored icon row — the globe and the nav
               arrows sit together. No title text: it's variable-length, shoved the
               arrows sideways on every navigation, and didn't fit the narrow band
               (even "Hyperia" barely fits). The URL bar shows the page identity;
               the globe stays click-to-copy the pane name (transient confirm). */
            <>
              {/* Left-anchored icon row: globe + nav arrows, fixed (flexShrink:0). */}
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  flexShrink: 0
                }}
              >
                {resolvedIcon && (
                  <span style={{display: 'flex', alignItems: 'center', flexShrink: 0}}>{resolvedIcon}</span>
                )}
                {navCluster}
              </div>
              {/* Page title — TRUNCATED. The icons above are left-anchored, so this
                  shrinks/ellipsizes first and can never shove the arrows on
                  navigation. Click to copy the full name; full title on hover. */}
              <span
                className="pane-band-name-cluster"
                onClick={handleNameClick}
                onContextMenu={handleNameContextMenu}
                title={copied ? 'Copied ✓' : 'Click to copy name'}
                style={{
                  flex: '0 1 auto',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '11px',
                  fontWeight: 500,
                  opacity: 0.75,
                  cursor: 'pointer',
                  padding: '2px var(--space-4)',
                  borderRadius: 'var(--radius-4)'
                }}
              >
                {copied ? 'Copied ✓' : label}
              </span>
            </>
          ) : (
            <>
              {/* Name Cluster */}
              <div
                className="pane-band-name-cluster"
                onClick={handleNameClick}
                onContextMenu={handleNameContextMenu}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-6)',
                  fontSize: '11px',
                  fontWeight: 500,
                  flexShrink: 1,
                  minWidth: 0,
                  cursor: 'pointer',
                  position: 'relative',
                  padding: '2px var(--space-4)',
                  borderRadius: 'var(--radius-4)',
                  transition: 'background 0.15s ease',
                  overflowX: 'auto',
                  whiteSpace: 'nowrap'
                }}
                title="Click to copy name (scroll to view full)"
              >
                {!isPlaceholder && resolvedIcon && (
                  <span style={{display: 'flex', alignItems: 'center', flexShrink: 0}}>{resolvedIcon}</span>
                )}
                {isPlaceholder ? (
                  <span
                    style={{
                      color: 'var(--text-tertiary)',
                      fontStyle: 'italic',
                      fontWeight: 400,
                      whiteSpace: 'nowrap',
                      flexShrink: 0
                    }}
                  >
                    {copied ? 'Copied ✓' : label}
                  </span>
                ) : (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 'var(--space-4)',
                      whiteSpace: 'nowrap',
                      flexShrink: 0
                    }}
                  >
                    {copied ? (
                      'Copied ✓'
                    ) : (
                      <>
                        {label}
                        {profileChip}
                      </>
                    )}
                  </span>
                )}
              </div>

              {/* Nav Cluster */}
              {navCluster}
            </>
          )}

          {/* Location Bar */}
          {locationBar}
        </div>

        {/* Controls Cluster — splits + close, anchored to the right. */}
        <div
          className="pane-band-controls-cluster"
          style={{display: 'flex', alignItems: 'center', gap: 'var(--space-10)', flexShrink: 0}}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Pulse (re-poke watchdog) — clock toggle, mirrors the sticky timer icon.
              Pulses (animates) while a pulse is active so it's obvious it's running. */}
          {paneId && !isPlaceholder && (
            <>
              <style>{`@keyframes hyPulseRun{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.72)}}`}</style>
              <span
                className="pane-band-control-icon pane-band-tooltip-trigger"
                title={pulseActive ? 'Pulse running — click to edit or clear' : 'Set a periodic pulse (re-poke this pane)'}
                onClick={(e) => {
                  e.stopPropagation();
                  setPulseOpen((v) => !v);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: pulseActive ? 'var(--accent-primary, #6ea8fe)' : undefined,
                  animation: pulseActive ? 'hyPulseRun 1.4s ease-in-out infinite' : undefined
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <polyline points="12 7 12 12 15 14" />
                </svg>
              </span>
            </>
          )}

          {/* Layouts Button */}
          {paneId && !isPlaceholder && !isSplitRightDisabled && !isSplitDownDisabled && (
            <span
              className="pane-band-control-icon pane-band-tooltip-trigger"
              style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18M15 3v18M3 9h18M3 15h18" strokeDasharray="2,2" opacity="0.5" />
                <rect x="4" y="4" width="4" height="4" fill="currentColor" opacity="0.3" />
                <rect x="16" y="16" width="4" height="4" fill="currentColor" opacity="0.3" />
              </svg>
              <div className="pane-band-tooltip pane-band-layout-tooltip" style={{minWidth: '180px'}}>
                <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 600, marginBottom: '8px', textAlign: 'center'}}>
                  Quick Layouts
                </div>
                <div className="pane-band-layout-grid">
                  <div 
                    className="pane-band-layout-item" 
                    onClick={(e) => openLayout('3cols', paneId, e.shiftKey ? (paneType === 'shell' ? 'default' : paneType) : undefined)} 
                    title="3 Columns (Shift+Click to Clone)"
                  >
                    <div className="layout-preview-box l-3cols">
                      <div /><div /><div />
                    </div>
                  </div>
                  <div 
                    className="pane-band-layout-item" 
                    onClick={(e) => openLayout('3rows', paneId, e.shiftKey ? (paneType === 'shell' ? 'default' : paneType) : undefined)} 
                    title="3 Rows (Shift+Click to Clone)"
                  >
                    <div className="layout-preview-box l-3rows">
                      <div /><div /><div />
                    </div>
                  </div>
                  <div 
                    className="pane-band-layout-item" 
                    onClick={(e) => openLayout('grid2x2', paneId, e.shiftKey ? (paneType === 'shell' ? 'default' : paneType) : undefined)} 
                    title="Grid 2x2 (Shift+Click to Clone)"
                  >
                    <div className="layout-preview-box l-grid2x2">
                      <div /><div /><div /><div />
                    </div>
                  </div>
                </div>
              </div>
            </span>
          )}

          {/* Split Down */}
          {!isSplitDownDisabled && (
            <span
              className="pane-band-control-icon pane-band-tooltip-trigger"
              onClick={(e) => {
                e.stopPropagation();
                const profile = e.shiftKey ? (paneType === 'shell' ? 'default' : paneType) : 'picker';
                const rpc = (window as any).rpc;
                if (rpc && paneId) {
                  rpc.emit('split request horizontal', { activeUid: paneId, profile });
                } else {
                  onSplitDown();
                }
              }}
              style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="12" x2="21" y2="12" />
              </svg>
              <div className="pane-band-tooltip pane-band-split-down-tooltip">
                <div 
                  className="pane-band-tooltip-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    const profile = e.shiftKey ? (paneType === 'shell' ? 'default' : paneType) : 'picker';
                    const rpc = (window as any).rpc;
                    if (rpc && paneId) {
                      rpc.emit('split request horizontal', { activeUid: paneId, profile });
                    } else {
                      onSplitDown();
                    }
                  }}
                  title="Split Down (Shift+Click to Clone)"
                >
                  <span className="tooltip-item-label">Split Down</span>
                  <span className="tooltip-item-key">Ctrl+Shift+_</span>
                </div>
                <div 
                  className="pane-band-tooltip-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    const profile = e.shiftKey ? (paneType === 'shell' ? 'default' : paneType) : 'picker';
                    const rpc = (window as any).rpc;
                    if (rpc && paneId) {
                      rpc.emit('split request horizontal', { activeUid: paneId, profile, splitPlacement: 'BEFORE' });
                    } else {
                      if (onSplitUp) onSplitUp();
                    }
                  }}
                  title="Split Up (Shift+Click to Clone)"
                >
                  <span className="tooltip-item-label">Split Up</span>
                  <span className="tooltip-item-key">Place to Top</span>
                </div>
                <div style={{height: '0.5px', background: 'var(--border-neutral)', margin: '4px 0'}} />
                <div 
                  className="pane-band-tooltip-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rpc = (window as any).rpc;
                    if (rpc && paneId) {
                      rpc.emit('split request horizontal', {
                        activeUid: paneId,
                        profile: paneType === 'shell' ? 'default' : paneType
                      });
                    }
                  }}
                >
                  <span className="tooltip-item-label">Clone Down</span>
                  <span className="tooltip-item-key">Ctrl+Alt+Shift+_</span>
                </div>
                <div 
                  className="pane-band-tooltip-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rpc = (window as any).rpc;
                    if (rpc && paneId) {
                      rpc.emit('split request horizontal', {
                        activeUid: paneId,
                        profile: paneType === 'shell' ? 'default' : paneType,
                        splitPlacement: 'BEFORE'
                      });
                    }
                  }}
                >
                  <span className="tooltip-item-label">Clone Up</span>
                  <span className="tooltip-item-key">Place to Top</span>
                </div>
              </div>
            </span>
          )}

          {/* Split Right */}
          {!isSplitRightDisabled && (
            <span
              className="pane-band-control-icon pane-band-tooltip-trigger"
              onClick={(e) => {
                e.stopPropagation();
                const profile = e.shiftKey ? (paneType === 'shell' ? 'default' : paneType) : 'picker';
                const rpc = (window as any).rpc;
                if (rpc && paneId) {
                  rpc.emit('split request vertical', { activeUid: paneId, profile });
                } else {
                  onSplitRight();
                }
              }}
              style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
              <div className="pane-band-tooltip pane-band-split-right-tooltip">
                <div 
                  className="pane-band-tooltip-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    const profile = e.shiftKey ? (paneType === 'shell' ? 'default' : paneType) : 'picker';
                    const rpc = (window as any).rpc;
                    if (rpc && paneId) {
                      rpc.emit('split request vertical', { activeUid: paneId, profile });
                    } else {
                      onSplitRight();
                    }
                  }}
                  title="Split Right (Shift+Click to Clone)"
                >
                  <span className="tooltip-item-label">Split Right</span>
                  <span className="tooltip-item-key">Ctrl+Shift+D</span>
                </div>
                <div 
                  className="pane-band-tooltip-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    const profile = e.shiftKey ? (paneType === 'shell' ? 'default' : paneType) : 'picker';
                    const rpc = (window as any).rpc;
                    if (rpc && paneId) {
                      rpc.emit('split request vertical', { activeUid: paneId, profile, splitPlacement: 'BEFORE' });
                    } else {
                      if (onSplitLeft) onSplitLeft();
                    }
                  }}
                  title="Split Left (Shift+Click to Clone)"
                >
                  <span className="tooltip-item-label">Split Left</span>
                  <span className="tooltip-item-key">Place to Left</span>
                </div>
                <div style={{height: '0.5px', background: 'var(--border-neutral)', margin: '4px 0'}} />
                <div 
                  className="pane-band-tooltip-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rpc = (window as any).rpc;
                    if (rpc && paneId) {
                      rpc.emit('split request vertical', {
                        activeUid: paneId,
                        profile: paneType === 'shell' ? 'default' : paneType
                      });
                    }
                  }}
                >
                  <span className="tooltip-item-label">Clone Right</span>
                  <span className="tooltip-item-key">Ctrl+Alt+Shift+D</span>
                </div>
                <div 
                  className="pane-band-tooltip-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rpc = (window as any).rpc;
                    if (rpc && paneId) {
                      rpc.emit('split request vertical', {
                        activeUid: paneId,
                        profile: paneType === 'shell' ? 'default' : paneType,
                        splitPlacement: 'BEFORE'
                      });
                    }
                  }}
                >
                  <span className="tooltip-item-label">Clone Left</span>
                  <span className="tooltip-item-key">Place to Left</span>
                </div>
              </div>
            </span>
          )}

          {/* Close */}
          <span
            className="pane-band-control-icon pane-band-tooltip-trigger"
            onClick={(e) => {
              e.stopPropagation();
              if (isBusy && !confirmClose) {
                setConfirmClose(true);
                if (confirmCloseTimeoutRef.current) {
                  clearTimeout(confirmCloseTimeoutRef.current);
                }
                confirmCloseTimeoutRef.current = setTimeout(() => {
                  setConfirmClose(false);
                }, 3000);
                return;
              }
              onClose();
            }}
            style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative'}}
          >
            {/* Inline SVG (not the `ti` icon font, which may not be loaded —
                that's why the close × was invisible while the split controls,
                which already use inline SVG, showed). currentColor inherits
                the control-icon color so it stays visible + hover-tinted. */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{cursor: 'pointer'}}
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            <div className="pane-band-tooltip" style={{right: '-2px'}}>
              <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>
                {resolvedTint === 'neutral' && paneType === 'web' ? 'Restore terminal' : 'Close pane'}
              </div>
              <div
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                  marginTop: 'var(--space-2)'
                }}
              >
                {resolvedTint === 'neutral' && paneType === 'web' ? 'Escape' : 'Ctrl+Shift+W'}
              </div>
            </div>
            {confirmClose && (
              <div
                className="pane-band-confirm-close-toast"
                style={{
                  position: 'absolute',
                  top: '28px',
                  right: '0px',
                  background: 'var(--accent-warning, #d29922)',
                  color: '#0f0f18',
                  padding: 'var(--space-4) var(--space-8)',
                  borderRadius: 'var(--radius-3)',
                  fontSize: '11px',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                  zIndex: 3000,
                  pointerEvents: 'none'
                }}
              >
                Click again to close
              </div>
            )}
          </span>
        </div>

        {pulseOpen && paneId && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              right: 8,
              zIndex: 60,
              width: 'min(320px, calc(100% - 16px))',
              maxWidth: 320,
              padding: '12px 14px',
              boxSizing: 'border-box',
              background: 'var(--bg-elevated, var(--bg-secondary, #1c1c22))',
              border: '1px solid var(--accent-primary, #6ea8fe)',
              borderRadius: 10,
              boxShadow: '0 10px 24px rgba(0,0,0,0.45)',
              color: 'var(--text-primary, #e8e8ea)',
              fontFamily: 'var(--font-sans)',
              cursor: 'default'
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 12.5}}>
              <span style={{fontSize: 14}}>⏱</span>
              <b>Periodic pulse</b>
              <span style={{color: 'var(--text-secondary, #9a9aa2)', fontSize: 11}}>— re-pokes this pane</span>
            </div>

            <textarea
              value={pKeys}
              onChange={(e) => setPKeys(e.target.value)}
              placeholder="Prompt to re-submit (e.g. continue, or status?)"
              rows={2}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                resize: 'vertical',
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 12,
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid var(--border-neutral, rgba(255,255,255,0.15))',
                background: 'var(--bg-secondary, #15151a)',
                color: 'inherit',
                marginBottom: 10
              }}
            />

            <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
              <span style={{fontSize: 10, color: 'var(--text-secondary, #9a9aa2)', width: 52, flexShrink: 0}}>Every</span>
              <div style={{display: 'flex', gap: 4}}>
                {([['30s', 30], ['1m', 60], ['2m', 120], ['5m', 300]] as const).map(([lbl, secs]) => (
                  <button key={lbl} type="button" onClick={() => setPInterval(secs)} style={pulseSeg(pInterval === secs)}>
                    {lbl}
                  </button>
                ))}
                <button
                  key="rand"
                  type="button"
                  title="Random interval 30s–5m (jitter so pulses don't fire in lockstep)"
                  onClick={() => setPInterval(30 + Math.floor(Math.random() * 271))}
                  style={pulseSeg(![30, 60, 120, 300].includes(pInterval))}
                >
                  {[30, 60, 120, 300].includes(pInterval) ? '⚄ rand' : `⚄ ${pInterval}s`}
                </button>
              </div>
            </div>

            <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
              <span style={{fontSize: 10, color: 'var(--text-secondary, #9a9aa2)', width: 52, flexShrink: 0}}>When</span>
              <div style={{display: 'flex', gap: 4}}>
                <button type="button" onClick={() => setPIdleOnly(true)} style={pulseSeg(pIdleOnly)}>
                  Only if idle
                </button>
                <button type="button" onClick={() => setPIdleOnly(false)} style={pulseSeg(!pIdleOnly)}>
                  Always
                </button>
              </div>
            </div>

            <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12}}>
              <span style={{fontSize: 10, color: 'var(--text-secondary, #9a9aa2)', width: 52, flexShrink: 0}}>For</span>
              <div style={{display: 'flex', gap: 4}}>
                {([['15 min', 900], ['1 hour', 3600]] as const).map(([lbl, secs]) => (
                  <button key={lbl} type="button" onClick={() => setPLifetime(secs)} style={pulseSeg(pLifetime === secs)}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
                fontSize: 11,
                cursor: 'pointer',
                color: 'var(--text-secondary, #9a9aa2)'
              }}
            >
              <input type="checkbox" checked={pSubmit} onChange={(e) => setPSubmit(e.target.checked)} />
              Submit to agent (press Enter) — uncheck to type only
            </label>

            <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
              <button
                type="button"
                disabled={pBusy}
                onClick={pulseActive ? clearPulse : () => setPulseOpen(false)}
                style={pulseBtn(false, pBusy)}
              >
                {pulseActive ? 'Clear and close' : 'Cancel'}
              </button>
              <button
                type="button"
                disabled={pBusy || !pKeys.trim()}
                onClick={submitPulse}
                style={pulseBtn(true, pBusy)}
              >
                {pulseActive ? 'Update' : 'Set'}
              </button>
            </div>
          </div>
        )}

        <style jsx>{`
          .pane-band-container {
            display: flex;
            align-items: center;
            font-family: var(--font-sans);
            font-size: 11px;
            font-weight: var(--weight-medium);
            padding-left: var(--space-10);
            user-select: none;
            box-sizing: border-box;
            text-transform: none;
            width: 100%;
          }

          .pane-band-height-compact {
            height: var(--band-height-compact);
          }

          .pane-band-height-normal {
            height: var(--band-height);
          }

          .pane-band-tint-neutral {
            background: var(--bg-secondary);
            color: var(--text-secondary);
          }

          .pane-band-tint-success {
            background: var(--bg-success);
            color: var(--text-success);
          }

          .pane-band-tint-info {
            background: var(--bg-info);
            color: var(--text-info);
          }

          .pane-band-tint-warning {
            background: var(--bg-warning);
            color: var(--text-warning);
          }

          .pane-band-tint-danger {
            background: var(--bg-danger);
            color: var(--text-danger);
          }

          .pane-band-tint-ai {
            background: var(--bg-ai);
            color: var(--text-ai);
          }

          .pane-band-control-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            color: var(--text-secondary);
            transition: color 0.15s ease;
            position: relative;
            padding: var(--space-2);
          }

          .pane-band-control-icon:hover {
            color: var(--text-primary);
          }

          .pane-band-tooltip-trigger {
            position: relative;
          }

          .pane-band-tooltip {
            display: none;
            position: absolute;
            top: 20px;
            background: var(--bg-primary);
            border: 0.5px solid var(--border-neutral);
            border-radius: var(--radius-4);
            padding: var(--space-8);
            white-space: nowrap;
            z-index: 1000;
            text-align: left;
            pointer-events: auto;
            box-shadow: 0 6px 16px rgba(0,0,0,0.35);
          }

          /* Positioning individual tooltips */
          .pane-band-layout-tooltip {
            right: -6px;
            left: auto;
            min-width: 180px;
          }

          .pane-band-split-down-tooltip {
            right: -6px;
            left: auto;
            min-width: 220px;
          }

          .pane-band-split-right-tooltip {
            right: -6px;
            left: auto;
            min-width: 220px;
          }

          /* Hover bridge positioning to prevent overlapping other icons */
          .pane-band-tooltip::before {
            content: '';
            position: absolute;
            top: -12px;
            height: 12px;
            background: transparent;
          }

          .pane-band-layout-tooltip::before {
            right: 6px;
            width: 20px;
          }

          .pane-band-split-down-tooltip::before {
            right: 6px;
            width: 20px;
          }

          .pane-band-split-right-tooltip::before {
            right: 6px;
            width: 20px;
          }

          .pane-band-tooltip-trigger:hover .pane-band-tooltip {
            display: block;
          }

          /* Clickable tooltip items with labels and shortcuts */
          .pane-band-tooltip-item {
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 8px;
            border-radius: 4px;
            font-size: 11px;
            color: var(--text-primary);
            transition: background 0.15s ease;
            gap: 16px;
          }

          .pane-band-tooltip-item:hover {
            background: rgba(255, 255, 255, 0.08);
          }

          .tooltip-item-label {
            font-weight: 500;
          }

          .tooltip-item-key {
            font-size: 10px;
            font-family: var(--font-mono);
            color: var(--text-secondary);
          }

          /* Layouts grid */
          .pane-band-layout-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
            padding: 4px;
          }

          .pane-band-layout-item {
            cursor: pointer;
            border-radius: 4px;
            border: 1px solid var(--border-neutral);
            padding: 4px;
            background: rgba(255, 255, 255, 0.02);
            transition: all 0.15s ease;
          }

          .pane-band-layout-item:hover {
            border-color: var(--accent-primary, #6ea8fe);
            background: rgba(110, 168, 254, 0.15);
            transform: translateY(-1px);
          }

          .layout-preview-box {
            width: 48px;
            height: 32px;
            background: rgba(0, 0, 0, 0.25);
            border-radius: 2px;
            overflow: hidden;
            display: flex;
            gap: 1px;
            border: 0.5px solid rgba(255, 255, 255, 0.15);
          }

          .layout-preview-box div {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 1px;
          }

          /* 3cols */
          .l-3cols > div {
            flex: 1;
          }

          /* 3rows */
          .l-3rows {
            flex-direction: column;
          }
          .l-3rows > div {
            flex: 1;
          }

          /* grid2x2 */
          .l-grid2x2 {
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-template-rows: 1fr 1fr;
            gap: 1px;
          }



          .pane-band-name-cluster {
            scrollbar-width: none !important;
          }

          .pane-band-name-cluster::-webkit-scrollbar {
            display: none !important;
          }

          .pane-band-name-cluster:hover {
            background: rgba(255, 255, 255, 0.08) !important;
          }

          .pane-band-copied-badge {
            position: absolute;
            top: 100%;
            left: var(--space-10);
            margin-top: 4px;
            background: var(--info-text);
            color: #ffffff;
            font-size: 10px;
            font-weight: 600;
            padding: 2px 6px;
            border-radius: var(--radius-4);
            white-space: nowrap;
            z-index: 1010;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            pointer-events: none;
            animation: paneCopiedPop 1s ease-in-out forwards;
          }

          @keyframes paneCopiedPop {
            0% {
              opacity: 0;
              transform: translateX(-50%) translateY(4px) scale(0.9);
            }
            15% {
              opacity: 1;
              transform: translateX(-50%) translateY(0) scale(1);
            }
            80% {
              opacity: 1;
              transform: translateX(-50%) translateY(0) scale(1);
            }
            100% {
              opacity: 0;
              transform: translateX(-50%) translateY(-6px) scale(0.95);
            }
          }
        `}</style>
      </div>
    );
  }
);
PaneBand.displayName = 'PaneBand';
