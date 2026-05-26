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
      height = 'compact'
    },
    ref
  ) => {
    const resolvedTint = isPlaceholder ? 'neutral' : tint;
    const isAi = paneType === 'ai';

    // Default fallback icons if none provided
    const resolvedIcon =
      icon !== undefined ? (
        icon
      ) : isAi ? (
        <i className="ti ti-sparkles" style={{fontSize: '12px', color: 'var(--color-text-ai, #3C3489)'}} />
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
          justifyContent: 'space-between',
          alignItems: 'center',
          width: '100%',
          paddingRight: 'var(--space-10)',
          flexShrink: 0,
          boxSizing: 'border-box',
          cursor: onClick ? 'pointer' : 'default',
          userSelect: 'none'
        }}
      >
        {/* Name Cluster */}
        <div
          className="pane-band-name-cluster"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-6)',
            fontSize: '11px',
            fontWeight: 500,
            flexShrink: 0
          }}
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
        </div>

        {/* Nav Cluster */}
        {navCluster}

        {/* Location Bar */}
        {locationBar}

        {/* Controls Cluster */}
        <div
          className="pane-band-controls-cluster"
          style={{display: 'flex', alignItems: 'center', gap: 'var(--space-10)'}}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Split Right */}
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
                Ctrl+Shift+|
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
                Ctrl+Alt+Shift+|
              </div>
            </div>
          </span>

          {/* Split Down */}
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

          {/* Close */}
          <span
            className="pane-band-control-icon pane-band-tooltip-trigger"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
          >
            <i className="ti ti-x" style={{fontSize: '12px', cursor: 'pointer'}} aria-hidden="true" />
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
            top: 22px;
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
        `}</style>
      </div>
    );
  }
);
PaneBand.displayName = 'PaneBand';
