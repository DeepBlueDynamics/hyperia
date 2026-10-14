import React from 'react';

import './pane-count-badge.css';

// A saved tab's pane count drawn as a small bright window: outline, title bar,
// number inside. Replaces the near-invisible "N▢" text.
const PaneCountBadge: React.FC<{count: number; webPanes?: number}> = ({count, webPanes = 0}) => {
  const title = `${count} pane${count === 1 ? '' : 's'}${webPanes ? ` (${webPanes} web)` : ''}`;
  return (
    <span title={title} aria-label={title} className="hy-pcb-badge">
      {count}
    </span>
  );
};

export default PaneCountBadge;
