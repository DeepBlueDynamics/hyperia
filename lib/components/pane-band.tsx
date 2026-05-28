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
  paneName?: string; // Explicit string to copy to clipboard
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
    const props = node.props as any;
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
      paneName
    },
    ref
  ) => {
    const resolvedTint = isPlaceholder ? 'neutral' : tint;
    const isAi = paneType === 'ai';

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
      const textToCopy = paneName || getTextFromNode(label) || 'Pane';
      const cleanText = textToCopy.trim();
      if (cleanText) {
        navigator.clipboard.writeText(cleanText)
          .then(() => {
            setCopied(true);
          })
          .catch((err) => {
            console.error('Failed to copy pane name to clipboard:', err);
          });
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
        <span>⚡</span>
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
          userSelect: 'none'
        }}
      >
        {/* Left-justified content */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-8)',
            flex: 1,
            minWidth: 0
          }}
        >
          {/* Name Cluster */}
          <div
            className="pane-band-name-cluster"
            onClick={handleNameClick}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-6)',
              fontSize: '11px',
              fontWeight: 500,
              flexShrink: 0,
              cursor: 'pointer',
              position: 'relative',
              padding: '2px var(--space-4)',
              borderRadius: 'var(--radius-4)',
              transition: 'background 0.15s ease',
            }}
            title="Click to copy name"
          >
            {!isPlaceholder && resolvedIcon && (
              <span style={{display: 'flex', alignItems: 'center'}}>{resolvedIcon}</span>
            )}
            {isPlaceholder ? (
              <span style={{color: 'var(--text-tertiary)', fontStyle: 'italic', fontWeight: 400}}>{label}</span>
            ) : (
              <span style={{display: 'inline-flex', alignItems: 'center', gap: 'var(--space-4)'}}>
                {label}
                {profileChip}
              </span>
            )}
            {copied && <div className="pane-band-copied-badge">Copied!</div>}
          </div>

          {/* Nav Cluster */}
          {navCluster}

          {/* Location Bar */}
          {locationBar}
        </div>

        {/* Controls Cluster */}
        <div
          className="pane-band-controls-cluster"
          style={{display: 'flex', alignItems: 'center', gap: 'var(--space-10)'}}
          onClick={(e) => e.stopPropagation()}
        >
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

          {/* Close */}
          <span
            className="pane-band-control-icon pane-band-tooltip-trigger"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
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

          .pane-band-name-cluster:hover {
            background: rgba(255, 255, 255, 0.08) !important;
          }

          .pane-band-copied-badge {
            position: absolute;
            top: -24px;
            left: 50%;
            transform: translateX(-50%);
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
