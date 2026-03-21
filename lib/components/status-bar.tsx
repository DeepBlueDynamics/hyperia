import React from 'react';

import type {AgentStatus} from '../../typings/hyper';

interface StatusBarProps {
  agentStatus?: AgentStatus;
  onHamburgerMenu?: (coords: {x: number; y: number}) => void;
}

const StatusBar: React.FC<StatusBarProps> = ({agentStatus, onHamburgerMenu}) => {
  const status = agentStatus || {connected: false};

  const handleHamburger = (e: React.MouseEvent) => {
    const {left: x, top: y} = e.currentTarget.getBoundingClientRect();
    if (onHamburgerMenu) {
      onHamburgerMenu({x, y: y - 10});
    }
  };

  const dotColor = status.working ? '#ff3333' : status.connected ? '#00ff64' : '#666';
  const humanPct = status.humanPercent ?? 100;
  const label = status.label || (status.working ? 'Agent working' : status.connected ? 'Agent connected' : 'No agent');

  return (
    <div className="statusbar">
      <div className="statusbar_left">
        {onHamburgerMenu && (
          <div className="statusbar_hamburger" onClick={handleHamburger} title="Menu">
            <svg viewBox="0 0 10 10" width="10" height="10">
              <rect y="1" width="10" height="1.2" fill="currentColor" />
              <rect y="4.4" width="10" height="1.2" fill="currentColor" />
              <rect y="7.8" width="10" height="1.2" fill="currentColor" />
            </svg>
          </div>
        )}
        <span
          className={`statusbar_dot ${status.connected || status.working ? 'statusbar_glow' : ''}`}
          style={{
            backgroundColor: dotColor,
            boxShadow: status.working
              ? '0 0 8px 3px rgba(255,50,50,0.5)'
              : status.connected
                ? '0 0 6px 2px rgba(0,255,100,0.4)'
                : 'none'
          }}
        />
        <span className="statusbar_label">{label}</span>
      </div>
      <div className="statusbar_right">
        <span className="statusbar_human">Human {humanPct}%</span>
      </div>

      <style jsx>{`
        .statusbar {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          height: 22px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 10px;
          font-size: 11px;
          color: #888;
          background: rgba(0, 0, 0, 0.6);
          z-index: 200;
          border-top: 1px solid #222;
          user-select: none;
        }

        .statusbar_left,
        .statusbar_right {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .statusbar_hamburger {
          cursor: pointer;
          color: #888;
          padding: 2px 4px;
          border-radius: 3px;
        }

        .statusbar_hamburger:hover {
          color: #fff;
          background: rgba(255, 255, 255, 0.1);
        }

        .statusbar_dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          transition: background-color 0.3s ease;
        }

        .statusbar_glow {
          box-shadow: 0 0 6px 2px rgba(0, 255, 100, 0.4);
        }

        .statusbar_label {
          color: #aaa;
        }

        .statusbar_human {
          color: #777;
        }
      `}</style>
    </div>
  );
};

StatusBar.displayName = 'StatusBar';

export default StatusBar;
