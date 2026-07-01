import {existsSync} from 'fs';

import React, {useState, useRef, useEffect} from 'react';

import type {configOptions} from '../../typings/config';
import {ipcRenderer} from '../utils/ipc';

export interface Props {
  defaultProfile: string;
  profiles: configOptions['profiles'];
  openNewTab: (name: string) => void;
  openWebPane?: (url: string) => void;
}

const Toolbar = ({defaultProfile, profiles, openNewTab, openWebPane}: Props) => {
  const [profileOpen, setProfileOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!profileOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [profileOpen]);

  const shellProfiles = (profiles || []).filter((p: any) => {
    if (!p.config?.shell) return false;
    try {
      return existsSync(p.config.shell as string);
    } catch {
      return false;
    }
  });

  const handleNewTab = () => openNewTab(defaultProfile);
  const handleNewTabContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setProfileOpen(!profileOpen);
  };
  const handleProfileSelect = (name: string) => {
    setProfileOpen(false);
    openNewTab(name);
  };
  const handleNewWindow = () => {
    ipcRenderer.send('new-window');
  };
  const handleNewSticky = () => {
    ipcRenderer.send('new-sticky');
  };

  return (
    <div className="toolbar_wrap" ref={ref}>
      <div className="toolbar_bar">
        {/* +> New terminal tab */}
        <div className="toolbar_btn" onClick={handleNewTab} title="New Tab">
          <span className="toolbar_plus">+</span>
        </div>

        {/* New window */}
        <div className="toolbar_btn" onClick={handleNewWindow} title="New Window">
          <svg viewBox="0 0 14 14" width="13" height="13">
            <rect x="1" y="3" width="10" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <rect x="3" y="1" width="10" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </div>

        {/* New sticky */}
        <div className="toolbar_btn" onClick={handleNewSticky} title="New Stickys">
          <svg viewBox="0 0 14 14" width="13" height="13">
            <path
              d="M2 1h10a1 1 0 0 1 1 1v7l-4 4H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path d="M9 8v5l4-4H9z" fill="currentColor" opacity="0.35" />
            <line x1="4" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
            <line x1="4" y1="7.5" x2="8" y2="7.5" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      <style jsx>{`
        .toolbar_wrap {
          position: fixed;
          top: 36px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 99;
        }

        .toolbar_bar {
          display: flex;
          gap: 1px;
          background: rgba(20, 20, 24, 0.6);
          border: 1px solid rgba(40, 40, 50, 0.4);
          border-radius: 0 0 6px 6px;
          padding: 2px;
          opacity: 0.25;
          transition:
            opacity 0.3s ease,
            background 0.3s ease,
            border-color 0.3s ease,
            box-shadow 0.3s ease;
        }

        .toolbar_wrap:hover .toolbar_bar {
          opacity: 1;
          background: rgba(15, 15, 22, 0.95);
          border-color: rgba(0, 150, 255, 0.3);
          box-shadow:
            0 0 8px rgba(0, 140, 255, 0.15),
            0 0 20px rgba(0, 100, 220, 0.08),
            inset 0 0 12px rgba(0, 120, 255, 0.05);
        }

        .toolbar_btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 24px;
          cursor: pointer;
          color: #556;
          border-radius: 3px;
          transition:
            color 0.2s ease,
            background 0.2s ease,
            box-shadow 0.2s ease;
          position: relative;
        }

        .toolbar_wrap:hover .toolbar_btn {
          color: #8af;
        }

        .toolbar_btn:hover {
          color: #fff !important;
          background: rgba(0, 140, 255, 0.15);
          box-shadow:
            0 0 6px rgba(0, 140, 255, 0.3),
            0 0 12px rgba(0, 100, 220, 0.1);
        }

        .toolbar_btn:active {
          color: #4df !important;
          background: rgba(0, 140, 255, 0.25);
        }

        .toolbar_plus {
          font-size: 14px;
          font-weight: 300;
          line-height: 1;
        }

        .toolbar_chevron {
          font-size: 14px;
          font-weight: 300;
          line-height: 1;
          margin-left: -2px;
        }

        .toolbar_dropdown {
          position: absolute;
          top: 100%;
          right: 0;
          margin-top: 4px;
          min-width: 160px;
          background: rgba(15, 15, 22, 0.97);
          border: 1px solid rgba(0, 150, 255, 0.25);
          border-radius: 6px;
          box-shadow:
            0 4px 16px rgba(0, 0, 0, 0.6),
            0 0 12px rgba(0, 120, 255, 0.1);
          padding: 4px 0;
          z-index: 1000;
        }

        .toolbar_option {
          padding: 6px 12px;
          font-size: 12px;
          color: #8af;
          cursor: pointer;
          white-space: nowrap;
          transition:
            background 0.15s ease,
            color 0.15s ease;
        }

        .toolbar_option:hover {
          background: rgba(0, 140, 255, 0.15);
          color: #fff;
        }

        .toolbar_option_active {
          color: #fff;
        }
      `}</style>
    </div>
  );
};

Toolbar.displayName = 'Toolbar';

export default Toolbar;
