import React from 'react';

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
  onClose: () => void;
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  height?: 'normal' | 'compact'; // maps to var(--band-height) | var(--band-height-compact)
  isSplitRightDisabled?: boolean;
  isSplitDownDisabled?: boolean;
  paneName?: string; // Optional override for the visible name used in click-to-copy
  paneId?: string; // Underlying UID — used ONLY to append a short suffix to the copied string for disambiguation
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
      onClose,
      onClick,
      onContextMenu,
      height = 'compact',
      isSplitRightDisabled = false,
      isSplitDownDisabled = false,
      paneName,
      paneId
    },
    ref
  ) => {
    const resolvedTint = isPlaceholder ? 'neutral' : tint;
    const isAi = paneType === 'ai';

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

    const handleNameClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      // Prefer the visible label text (what the user actually sees) and only
      // fall back to an explicit override or a generic placeholder. If we
      // know the underlying UID, append a short suffix so two panes with
      // the same name remain distinguishable. Shape:
      //   `<name> (pane <8charHex>)`
      // Pasting that anywhere reads as the human name first; the parenthetical
      // tells the reader (or an agent) the kind and gives a stable handle.
      const name = (getTextFromNode(label) || paneName || 'Pane').trim();
      const shortId = paneId ? paneId.replace(/-/g, '').slice(0, 8) : '';
      const cleanText = shortId ? `${name} (pane ${shortId})` : name;
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
      const name = (getTextFromNode(label) || paneName || 'Pane').trim();
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
              clipboard.writeText(shortId ? `${name} (pane ${shortId})` : name);
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
          {/* Split Down */}
          {!isSplitDownDisabled && (
            <span
              className="pane-band-control-icon pane-band-tooltip-trigger"
              onClick={(e) => {
                e.stopPropagation();
                onSplitDown();
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
              <div className="pane-band-tooltip">
                <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>Split down</div>
                <div
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                    marginTop: 'var(--space-2)'
                  }}
                >
                  Ctrl+Shift+_
                </div>
                <div style={{height: '0.5px', background: 'var(--border-neutral)', margin: 'var(--space-6) 0'}} />
                <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>Clone down</div>
                <div
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                    marginTop: 'var(--space-2)'
                  }}
                >
                  Ctrl+Alt+Shift+_
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
                onSplitRight();
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
              <div className="pane-band-tooltip">
                <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>Split right</div>
                <div
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                    marginTop: 'var(--space-2)'
                  }}
                >
                  Ctrl+Shift+D
                </div>
                <div style={{height: '0.5px', background: 'var(--border-neutral)', margin: 'var(--space-6) 0'}} />
                <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>Clone right</div>
                <div
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                    marginTop: 'var(--space-2)'
                  }}
                >
                  Ctrl+Alt+Shift+D
                </div>
              </div>
            </span>
          )}

          {/* Close */}
          <span
            className="pane-band-control-icon pane-band-tooltip-trigger"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0}}
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
          </span>
        </div>

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
            top: 28px;
            right: -6px;
            background: var(--bg-primary);
            border: 0.5px solid var(--border-neutral);
            border-radius: var(--radius-4);
            padding: var(--space-8) var(--space-12);
            white-space: nowrap;
            z-index: 1000;
            min-width: 140px;
            text-align: left;
            pointer-events: none;
          }

          .pane-band-tooltip-trigger:hover .pane-band-tooltip {
            display: block;
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
