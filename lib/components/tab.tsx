import React, {forwardRef, useState, useRef, useEffect} from 'react';

import type {TabProps} from '../../typings/hyper';

const Tab = forwardRef<HTMLLIElement, TabProps>((props, ref) => {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
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
    setRenameValue(description || tabName || props.text);
    setRenaming(true);
  };

  const handleRenameSubmit = () => {
    if (props.onDescribe && renameValue.trim()) {
      props.onDescribe(renameValue.trim());
    }
    setRenaming(false);
  };

  const handleRenameKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') handleRenameSubmit();
    if (e.key === 'Escape') setRenaming(false);
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const desc = window.prompt('Describe this tab:', description || '');
    if (desc !== null && props.onDescribe) {
      props.onDescribe(desc);
    }
  };

  const {isActive, isFirst, isLast, borderColor, hasActivity, agentStatus, tabName, description} = props;

  const displayText = description || tabName || props.text;

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
        } ${hasActivity ? 'tab_hasActivity' : ''}`}
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
          <span title={displayText} className={`tab_textInner ${isActive ? 'tab_textInnerActive' : ''}`} onDoubleClick={handleDoubleClick}>
            {hasActivity && !isActive && <span className="tab_bell">🔔</span>}
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
              <span className="tab_textContent">{displayText}</span>
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
          color: #999;
          list-style-type: none;
          flex: 1 1 0;
          min-width: 120px;
          max-width: 240px;
          position: relative;
          background: #1a1a1a;
          border-right: 1px solid #333;
          -webkit-app-region: no-drag;
          cursor: grab;
        }

        .tab_tab:active {
          cursor: grabbing;
        }

        .tab_tab[draggable]:drag-over {
          border-left: 2px solid #4488ff;
        }

        .tab_tab:hover {
          color: #ccc;
          background: #252525;
        }

        .tab_first {
        }

        .tab_firstActive {
        }

        .tab_active {
          color: #fff;
          background: #000;
        }
        .tab_active:hover {
          color: #fff;
          background: #000;
        }

        .tab_hasActivity {
          color: #50e3c2;
        }

        .tab_hasActivity:hover {
          color: #50e3c2;
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
          0%, 100% { transform: rotate(0deg); }
          20% { transform: rotate(14deg); }
          40% { transform: rotate(-14deg); }
          60% { transform: rotate(8deg); }
          80% { transform: rotate(-8deg); }
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
          display: inline-block;
        }

        .tab_textInnerActive .tab_textContent {
          animation: none;
        }

        @keyframes tab-scroll {
          0%, 20% {
            transform: translateX(0);
          }
          80%, 100% {
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
