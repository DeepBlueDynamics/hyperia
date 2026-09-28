import React from 'react';

// A saved tab's pane count drawn as a small bright window: outline, title bar,
// number inside. Replaces the near-invisible "N▢" text.
const PaneCountBadge: React.FC<{count: number; webPanes?: number}> = ({count, webPanes = 0}) => {
  const title = `${count} pane${count === 1 ? '' : 's'}${webPanes ? ` (${webPanes} web)` : ''}`;
  return (
    <span
      title={title}
      aria-label={title}
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        minWidth: '20px',
        height: '16px',
        padding: '0 4px',
        border: '1.5px solid var(--info-text, #6ea8fe)',
        borderTopWidth: '3px',
        borderRadius: '3px',
        color: 'var(--info-text, #6ea8fe)',
        fontSize: '10px',
        fontWeight: 700,
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      {count}
    </span>
  );
};

export default PaneCountBadge;
