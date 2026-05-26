import React, {forwardRef, useState, useRef, useEffect} from 'react';

import type {TabProps} from '../../typings/hyper';
import rpc from '../rpc';

const Tab = forwardRef<HTMLLIElement, TabProps>((props, ref) => {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [pendingName, setPendingName] = useState<string | null>(null);
  const renamingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const handleClick = (event: React.MouseEvent) => {
    const isLeftClick = event.nativeEvent.which === 1;

    if (isLeftClick && !props.isActive) {
      props.onSelect();
    }
  };

  const handleMouseUp = (event: React.MouseEvent) => {
    const isMiddleClick = event.nativeEvent.which === 2;

    if (isMiddleClick) {
      props.onClose();
    }
  };

  const handleDoubleClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setRenameValue(pendingName ?? (description || tabName || props.text));
    setPendingName(null);
    renamingRef.current = true;
    setRenaming(true);
  };

  const handleRenameSubmit = () => {
    if (!renamingRef.current) return;
    renamingRef.current = false;
    const value = renameValue.trim();
    if (props.onDescribe && value) {
      setPendingName(value);
      props.onDescribe(value);
    }
    setRenaming(false);
  };

  const handleRenameKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') handleRenameSubmit();
    if (e.key === 'Escape') {
      renamingRef.current = false;
      setRenaming(false);
    }
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call */
    const remote = require('@electron/remote');
    const {Menu, MenuItem} = remote;
    const {clipboard, ipcMain} = require('electron');
    const menu = new Menu();

    if (props.isWebPane) {
      menu.append(
        new MenuItem({
          label: 'Reload',
          click: () => rpc.emit('web-pane-reload', props.uid)
        })
      );
      menu.append(new MenuItem({type: 'separator'}));
      menu.append(
        new MenuItem({
          label: 'Rename',
          click: () => {
            setRenameValue(pendingName ?? (description || tabName || props.text));
            setPendingName(null);
            renamingRef.current = true;
            setRenaming(true);
          }
        })
      );
      if (props.webUrl) {
        menu.append(
          new MenuItem({
            label: 'Copy URL',
            click: () => void clipboard.writeText(props.webUrl!)
          })
        );
      }
      menu.append(new MenuItem({type: 'separator'}));
      menu.append(new MenuItem({label: 'New Note', click: () => void ipcMain.emit('new-sticky', {})}));
      // Always show — shell pane handles the no-token case via bootstub.
      menu.append(new MenuItem({label: 'Ask Hyperia', click: () => void ipcMain.emit('open-ghost')}));
      menu.append(new MenuItem({type: 'separator'}));
      menu.append(new MenuItem({label: 'Close', click: () => props.onClose()}));
    } else {
      menu.append(
        new MenuItem({
          label: 'Rename',
          click: () => {
            setRenameValue(pendingName ?? (description || tabName || props.text));
            setPendingName(null);
            renamingRef.current = true;
            setRenaming(true);
          }
        })
      );
      menu.append(
        new MenuItem({
          label: `Copy ID (${props.uid.substring(0, 8)}...)`,
          click: () => void clipboard.writeText(props.uid)
        })
      );
      menu.append(new MenuItem({type: 'separator'}));
      menu.append(new MenuItem({label: 'Close', click: () => props.onClose()}));
    }

    menu.popup();
    /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call */
  };

  const {
    isActive,
    isFirst,
    isLast,
    borderColor,
    hasActivity,
    hasBell,
    agentStatus,
    tabName,
    description,
    isWebPane,
    webUrl,
    defaultProfile
  } = props;

  // Clear pendingName once Redux state has caught up to the committed rename.
  useEffect(() => {
    if (pendingName !== null && (tabName === pendingName || description === pendingName)) {
      setPendingName(null);
    }
  }, [tabName, description, pendingName]);

  const isFirstRun = !defaultProfile;
  // Optimistically show pendingName to avoid any flicker while Redux propagates.
  const displayText = isFirstRun ? 'untitled' : (pendingName ?? (tabName || description || props.text));

  // Agent dot color
  const agentDotColor = agentStatus?.working
    ? '#ff3333'
    : agentStatus?.connected && agentStatus.humanPercent !== undefined && agentStatus.humanPercent < 100
      ? '#ffaa00'
      : agentStatus?.connected
        ? '#00ff64'
        : null;

  return (
    <>
      <li
        onClick={props.onClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={props.onDragStart}
        onDragOver={props.onDragOver}
        onDrop={props.onDrop}
        onDragEnd={props.onDragEnd}
        style={{borderColor}}
        className={`tab_tab ${isFirst ? 'tab_first' : ''} ${isActive ? 'tab_active' : ''} ${
          isFirst && isActive ? 'tab_firstActive' : ''
        } ${hasActivity ? 'tab_hasActivity' : ''} ${isWebPane ? 'tab_webPane' : ''} ${isFirstRun ? 'tab_firstRun' : ''}`}
        ref={ref}
      >
        {props.customChildrenBefore}
        <span
          className={`tab_text ${isLast ? 'tab_textLast' : ''} ${isActive ? 'tab_textActive' : ''}`}
          onClick={handleClick}
          onMouseUp={handleMouseUp}
        >
          {agentDotColor && (
            <span
              className={`tab_agentDot ${agentStatus?.working ? 'tab_agentDotPulse' : ''}`}
              style={{backgroundColor: agentDotColor}}
            />
          )}
          <span
            title={props.text !== displayText ? props.text : ''}
            className={`tab_textInner ${isActive ? 'tab_textInnerActive' : ''}`}
            onDoubleClick={handleDoubleClick}
          >
            {hasBell && <span className="tab_bell">🔔</span>}
            {renaming ? (
              <input
                ref={inputRef}
                className="tab_renameInput"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={handleRenameKey}
                onBlur={handleRenameSubmit}
              />
            ) : (
              <span className="tab_textContent">
                <span className="tab_webIcon">{isWebPane ? '🌐' : null}</span>
                {isWebPane ? (
                  <span className={`tab_webUrl ${isActive ? 'tab_webUrlScroll' : ''}`} title={webUrl}>
                    {displayText}
                  </span>
                ) : (
                  displayText
                )}
              </span>
            )}
          </span>
        </span>
        <i className="tab_icon" onClick={props.onClose}>
          <svg className="tab_shape">
            <use xlinkHref="./renderer/assets/icons.svg#close-tab" />
          </svg>
        </i>
        {props.customChildren}
      </li>

      <style jsx>{`
        .tab_tab {
          color: var(--text-secondary);
          list-style-type: none;
          flex: 1 1 0;
          min-width: 72px;
          max-width: 200px;
          position: relative;
          background: var(--bg-secondary);
          border-right: 0.5px solid var(--border-neutral);
          -webkit-app-region: no-drag;
          cursor: grab;
          font-family: var(--font-sans);
          font-size: 11px;
          font-weight: 400;
        }

        .tab_tab:active {
          cursor: grabbing;
        }

        .tab_tab[draggable]:drag-over {
          border-left: 2px solid var(--border-focus);
        }

        .tab_tab:hover {
          color: var(--text-primary);
          background: var(--bg-tertiary);
        }

        .tab_first {
        }

        .tab_firstActive {
        }

        .tab_active {
          color: var(--text-primary);
          background: var(--bg-primary);
          font-weight: 500;
        }
        .tab_active:hover {
          color: var(--text-primary);
          background: var(--bg-primary);
        }

        .tab_webPane {
          background: var(--bg-secondary);
          border-right-color: var(--border-neutral);
        }
        .tab_webPane:hover {
          background: var(--bg-tertiary);
        }
        .tab_webPane.tab_active {
          background: var(--bg-primary);
          color: var(--text-primary);
          font-weight: 500;
        }
        .tab_webPane.tab_active:hover {
          background: var(--bg-primary);
        }

        .tab_hasActivity {
          color: #50e3c2;
        }

        .tab_hasActivity:hover {
          color: #50e3c2;
        }

        .tab_firstRun .tab_textContent {
          font-style: italic;
          color: var(--text-tertiary) !important;
        }

        .tab_text {
          transition: color 0.2s ease;
          height: 34px;
          display: flex;
          align-items: center;
          width: 100%;
          position: relative;
          overflow: hidden;
          padding-left: 8px;
          padding-right: 28px;
          box-sizing: border-box;
        }

        .tab_renameInput {
          background: rgba(0, 20, 40, 0.6);
          border: 1px solid rgba(0, 150, 255, 0.3);
          border-radius: 3px;
          color: #cef;
          font-size: 12px;
          padding: 1px 6px;
          outline: none;
          width: 100%;
          text-align: center;
          font-family: inherit;
        }

        .tab_renameInput:focus {
          border-color: rgba(0, 170, 255, 0.5);
          box-shadow: 0 0 6px rgba(0, 140, 255, 0.25);
        }

        .tab_bell {
          font-size: 10px;
          margin-right: 4px;
          animation: tab-bell-ring 0.6s ease;
        }

        @keyframes tab-bell-ring {
          0%,
          100% {
            transform: rotate(0deg);
          }
          20% {
            transform: rotate(14deg);
          }
          40% {
            transform: rotate(-14deg);
          }
          60% {
            transform: rotate(8deg);
          }
          80% {
            transform: rotate(-8deg);
          }
        }

        .tab_textInner {
          padding: 0 12px;
          text-align: center;
          text-overflow: ellipsis;
          white-space: nowrap;
          overflow: hidden;
          flex: 1;
          line-height: 34px;
          min-width: 0;
        }

        .tab_textInnerActive {
          overflow: hidden;
        }

        .tab_textContent {
          display: inline-flex;
          align-items: center;
        }

        .tab_webIcon {
          font-size: 10px;
          margin-right: 4px;
          vertical-align: middle;
          opacity: 0.7;
          flex-shrink: 0;
        }

        .tab_webUrl {
          overflow: hidden;
          white-space: nowrap;
          font-size: 11px;
          opacity: 0.75;
          max-width: 100%;
          display: inline-block;
        }

        .tab_webUrlScroll {
          animation: tab-web-scroll 8s ease-in-out 1.5s infinite alternate;
        }

        @keyframes tab-web-scroll {
          0%,
          20% {
            transform: translateX(0);
          }
          80%,
          100% {
            transform: translateX(calc(-100% + 80px));
          }
        }

        .tab_textInnerActive .tab_textContent {
          animation: none;
        }

        @keyframes tab-scroll {
          0%,
          20% {
            transform: translateX(0);
          }
          80%,
          100% {
            transform: translateX(var(--scroll-distance));
          }
        }

        .tab_agentDot {
          position: absolute;
          left: 8px;
          top: 50%;
          transform: translateY(-50%);
          width: 8px;
          height: 8px;
          border-radius: 50%;
          z-index: 1;
        }

        .tab_agentDotPulse {
          animation: tab-agent-pulse 1.5s ease-in-out infinite;
        }

        @keyframes tab-agent-pulse {
          0%,
          100% {
            opacity: 1;
            transform: translateY(-50%) scale(1);
          }
          50% {
            opacity: 0.6;
            transform: translateY(-50%) scale(1.3);
          }
        }

        .tab_icon {
          transition:
            opacity 0.2s ease,
            color 0.2s ease,
            transform 0.25s ease,
            background-color 0.1s ease;
          cursor: pointer;
          pointer-events: none;
          position: absolute;
          right: 7px;
          top: 10px;
          display: inline-block;
          width: 14px;
          height: 14px;
          border-radius: 100%;
          color: #e9e9e9;
          opacity: 0;
          transform: scale(0.95);
        }

        .tab_icon:hover {
          background-color: rgba(255, 255, 255, 0.13);
          color: #fff;
        }

        .tab_icon:active {
          background-color: rgba(255, 255, 255, 0.1);
          color: #909090;
        }

        .tab_tab:hover .tab_icon {
          opacity: 1;
          transform: none;
          pointer-events: all;
        }

        .tab_shape {
          position: absolute;
          left: 4px;
          top: 4px;
          width: 6px;
          height: 6px;
          vertical-align: middle;
          fill: currentColor;
          shape-rendering: crispEdges;
        }
      `}</style>
    </>
  );
});

Tab.displayName = 'Tab';

export default Tab;
