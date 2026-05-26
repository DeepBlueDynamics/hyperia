/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {existsSync} from 'fs';

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
  // Optimistic override so right-click "set as default" updates the
  // visual highlight immediately without waiting for a config reload.
  const [localDefault, setLocalDefault] = useState<string | null>(null);
  const effectiveDefault = localDefault || defaultProfile;
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

  // Only show profiles that define a shell AND where the shell actually exists on this platform
  const shellProfiles = (profiles || []).filter((p: any) => {
    if (!p.config?.shell) return false;
    // Check if shell path exists (filter out Windows shells on Mac, Mac shells on Windows, etc.)
    try {
      return existsSync(p.config.shell);
    } catch {
      return false;
    }
  });

  const handleClick = () => {
    openNewTab(effectiveDefault);
  };

  const handleSetDefault = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    setLocalDefault(name);
    // Persist to ~/.hyperia/hyperia.json via main-process IPC.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {ipcRenderer} = require('electron') as {ipcRenderer: {send: (ch: string, ...args: any[]) => void}};
      ipcRenderer.send('set-default-profile', name);
    } catch {
      // Renderer might not have IPC available in some test contexts —
      // optimistic update still wins for this session.
    }
    // Don't close the dropdown — the user might want to launch right
    // after setting default. They can outside-click to dismiss.
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

  const handleNewWindow = () => {
    // TODO: open new Hyperia window
    console.log('new window');
  };

  const handleNewNote = () => {
    // TODO: open new sticky note
    console.log('new note');
  };

  return (
    <div className="new_tab_wrapper" ref={ref}>
      <div className="new_tab_split" onDoubleClick={(e) => e.stopPropagation()}>
        {/* +> New terminal tab */}
        <div
          className="new_tab_btn"
          onClick={handleClick}
          title="New Tab"
        >
          <span className="new_tab_icon">+</span>
        </div>
        {/* New window */}
        <div className="new_tab_btn" onClick={handleNewWindow} title="New Window">
          <svg viewBox="0 0 14 14" width="12" height="12">
            <rect x="1" y="3" width="10" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <rect x="3" y="1" width="10" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </div>
        {/* New sticky note */}
        <div className="new_tab_btn" onClick={handleNewNote} title="New Note">
          <svg viewBox="0 0 14 14" width="12" height="12">
            <path
              d="M2 1h10a1 1 0 0 1 1 1v7l-4 4H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path d="M9 8v5l4-4H9z" fill="currentColor" opacity="0.4" />
            <line x1="4" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            <line x1="4" y1="7.5" x2="8" y2="7.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </svg>
        </div>
      </div>

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

        .new_tab_btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          cursor: pointer;
          color: #888;
        }

        .new_tab_btn:hover {
          color: #fff;
          background: #252525;
        }

        .new_tab_icon {
          font-size: 14px;
          font-weight: 300;
          line-height: 1;
        }

        .new_tab_arrow_icon {
          font-size: 14px;
          font-weight: 300;
          line-height: 1;
          margin-left: -2px;
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

        .new_tab_option_star {
          color: #c839c5;
          margin-right: 6px;
          font-size: 11px;
        }

        .new_tab_hint {
          padding: 4px 12px 6px;
          font-size: 10px;
          color: #666;
          border-bottom: 1px solid #2a2a2a;
          margin-bottom: 2px;
          user-select: none;
        }
      `}</style>
    </div>
  );
};

export default NewTabButton;
/* eslint-enable @typescript-eslint/no-unsafe-argument */
