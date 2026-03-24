/* eslint-disable @typescript-eslint/no-unsafe-argument */
import React, {useState, useRef, useEffect} from 'react';

import type {configOptions} from '../../typings/config';

interface Props {
  defaultProfile: string;
  profiles: configOptions['profiles'];
  openNewTab: (name: string) => void;
  borderColor: string;
  tabsVisible: boolean;
  [key: string]: any;
}

const NewTabButton = ({defaultProfile, profiles, openNewTab}: Props) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Only show profiles that define a shell — visual-only profiles are not shell choices
  const shellProfiles = (profiles || []).filter((p: any) => p.config?.shell);

  const handleClick = () => {
    openNewTab(defaultProfile);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(!open);
  };

  const handleSelect = (name: string) => {
    setOpen(false);
    openNewTab(name);
  };

  return (
    <div className="new_tab_wrapper" ref={ref}>
      <div className="new_tab_split" onDoubleClick={(e) => e.stopPropagation()}>
        <div className="new_tab_plus" onClick={handleClick} onContextMenu={handleContextMenu} title={`New Tab (right-click for profiles)`}>
          <svg viewBox="0 0 12 12" width="10" height="10">
            <line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      {open && shellProfiles.length > 0 && (
        <div className="new_tab_dropdown">
          {shellProfiles.map((p: any) => (
            <div
              key={p.name}
              className={`new_tab_option ${p.name === defaultProfile ? 'new_tab_option_default' : ''}`}
              onClick={() => handleSelect(p.name)}
            >
              {p.name}
            </div>
          ))}
        </div>
      )}

      <style jsx>{`
        .new_tab_wrapper {
          position: relative;
          flex: 0 0 auto;
          z-index: 10;
          -webkit-app-region: no-drag;
        }

        .new_tab_split {
          display: flex;
          align-items: stretch;
          height: 34px;
          -webkit-app-region: no-drag;
        }

        .new_tab_plus {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          cursor: pointer;
          color: #888;
        }

        .new_tab_plus:hover {
          color: #fff;
          background: #252525;
        }

        .new_tab_arrow {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          cursor: pointer;
          color: #666;
          border-right: 1px solid #333;
        }

        .new_tab_arrow:hover {
          color: #fff;
          background: #303030;
        }

        .new_tab_dropdown {
          position: absolute;
          top: 34px;
          left: 0;
          min-width: 160px;
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 4px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
          z-index: 1000;
          padding: 4px 0;
          -webkit-app-region: no-drag;
        }

        .new_tab_option {
          padding: 6px 12px;
          font-size: 12px;
          color: #ccc;
          cursor: pointer;
          white-space: nowrap;
        }

        .new_tab_option:hover {
          background: #333;
          color: #fff;
        }

        .new_tab_option_default {
          color: #fff;
        }
      `}</style>
    </div>
  );
};

export default NewTabButton;
/* eslint-enable @typescript-eslint/no-unsafe-argument */
