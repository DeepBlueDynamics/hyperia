import React, {forwardRef, useState, useRef, useEffect} from 'react';

import type {TabProps} from '../../typings/hyper';
import rpc from '../rpc';

const PICKER_EMOJIS = [
  '🌐',
  '📌',
  '⭐',
  '🔥',
  '🚀',
  '🧠',
  '💻',
  '🎮',
  '🍎',
  '🐱',
  '🦄',
  '🦖',
  '🐼',
  '👻',
  '👺',
  '🧟',
  '👾',
  '🌪️',
  '⚡',
  '🥑',
  '🍩',
  '🌵',
  '🎈'
];

// eslint-disable-next-line no-misleading-character-class
const EMOJI_REGEX = /^([\p{Extended_Pictographic}\u200d\uFE0F]+)\s*(.*)$/u;

const parseTabName = (name: string, isWeb?: boolean, hasCustomName?: boolean) => {
  if (!name) return {emoji: isWeb && !hasCustomName ? '🌐' : '', text: ''};
  const match = EMOJI_REGEX.exec(name);
  if (match) {
    return {emoji: match[1], text: match[2]};
  }
  return {emoji: isWeb && !hasCustomName ? '🌐' : '', text: name};
};

// Pinned tabs collapse to the first letter of every word ("Brilliant Peacock"
// → "BP"), keeping the tab's emoji beside them. Spread iterates code points so
// a leading non-BMP character survives the slice.
const tabInitials = (text: string) =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => [...word][0].toUpperCase())
    .join('');

const Tab = forwardRef<HTMLLIElement, TabProps>((props, ref) => {
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
    defaultProfile,
    dragOffset
  } = props;
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const renamingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  // Activate on pointer-down rather than on click. A browser tab strip puts the
  // page on screen the instant you press a tab, so when you then drag that tab
  // to reorder it you are looking at the page you are carrying. Selecting on
  // release meant the whole drag happened while the *previous* tab's page was
  // still displayed, and the page only appeared once you let go.
  //
  // The close button and the rename editor live inside the same <li>, and a
  // press on either must not steal the selection.
  const handleMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0 || renaming) {
      return;
    }
    if ((event.target as Element).closest?.('.tab_icon, .tab_renameContainer')) {
      return;
    }
    if (!props.isActive) {
      props.onSelect();
    }
  };

  const handleMouseUp = (event: React.MouseEvent) => {
    const isMiddleClick = event.nativeEvent.which === 2;

    if (isMiddleClick) {
      props.onClose();
    }
  };

  const startRename = () => {
    const currentName = pendingName ?? (tabName || description || props.text) ?? '';
    const parsed = parseTabName(currentName, isWebPane);

    let finalEmoji = parsed.emoji;
    if (parsed.emoji === '🌐' || !parsed.emoji) {
      const randomIndex = Math.floor(Math.random() * PICKER_EMOJIS.length);
      finalEmoji = PICKER_EMOJIS[randomIndex];
    }

    setRenameValue(`${finalEmoji} ${parsed.text}`.trim());
    setPendingName(null);
    renamingRef.current = true;
    setRenaming(true);
  };

  const handleDoubleClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    startRename();
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
    /* eslint-disable @typescript-eslint/no-var-requires */
    const remote = require('@electron/remote');
    const {Menu, MenuItem} = remote;
    const {clipboard} = require('electron');
    const menu = new Menu();

    menu.append(
      new MenuItem({
        label: 'Rename',
        click: () => {
          startRename();
        }
      })
    );

    // Only offer the revert when the human actually typed a custom name —
    // agent/auto tab names (manualTabName=false) shouldn't show it.
    if (props.manualTabName || pendingName) {
      menu.append(
        new MenuItem({
          label: 'Use Automatic Name',
          click: () => {
            setPendingName('');
            if (props.onDescribe) {
              props.onDescribe('');
            }
          }
        })
      );
    }

    menu.append(
      new MenuItem({
        label: 'Copy tab name + ID',
        click: () => {
          const name = (pendingName ?? (tabName || description || props.text) ?? 'Tab').trim();
          const shortId = props.uid.replace(/-/g, '').slice(0, 8);
          void clipboard.writeText(`Hyperia Tab: ${name} (${shortId})`);
          setCopied(true);
          setTimeout(() => setCopied(false), 1000);
        }
      })
    );

    if (props.isWebPane) {
      menu.append(new MenuItem({type: 'separator'}));
      menu.append(
        new MenuItem({
          label: 'Reload',
          click: () => rpc.emit('web-pane-reload', props.uid)
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
      menu.append(
        new MenuItem({
          label: 'Show Page Title',
          type: 'checkbox',
          checked: !props.disableTitleInheritance,
          click: () => {
            if (props.onToggleTitleInheritance) {
              props.onToggleTitleInheritance();
            }
          }
        })
      );
    }

    menu.append(new MenuItem({type: 'separator'}));
    menu.append(
      new MenuItem({
        label: props.isPinned ? 'Unpin Tab' : 'Pin Tab',
        click: () => props.onPin?.()
      })
    );

    menu.append(new MenuItem({type: 'separator'}));
    menu.append(new MenuItem({label: 'Close', click: () => props.onClose()}));

    menu.popup();
    /* eslint-enable @typescript-eslint/no-var-requires */
  };

  // Clear pendingName once Redux state has caught up to the committed rename.
  useEffect(() => {
    if (pendingName !== null && (tabName === pendingName || description === pendingName)) {
      setPendingName(null);
    }
  }, [tabName, description, pendingName]);

  const isFirstRun = !defaultProfile;
  const rawText = pendingName ?? (tabName || description || props.text) ?? '';
  const parsed = parseTabName(rawText, isWebPane);
  // Optimistically show pendingName to avoid any flicker while Redux propagates.
  const displayText = copied ? 'Copied ✓' : isFirstRun ? 'untitled' : parsed.text;
  const isPinned = !!props.isPinned;
  // A pinned tab shrinks to its initials (emoji kept); the full name moves to
  // the hover tooltip.
  const shownText = isPinned && !copied && !isFirstRun ? tabInitials(displayText) : displayText;

  // Agent dot color
  const agentDotColor = agentStatus?.working
    ? '#ff3333'
    : agentStatus?.connected && agentStatus.humanPercent !== undefined && agentStatus.humanPercent < 100
      ? '#ffaa00'
      : agentStatus?.connected
        ? '#00ff64'
        : null;

  const paneColors = props.paneColors || [];
  const indicatorColor =
    paneColors.length === 0
      ? 'var(--text-info)'
      : paneColors.length === 1
        ? paneColors[0]
        : `linear-gradient(to right, ${paneColors.join(', ')})`;

  return (
    <>
      <li
        onClick={props.onClick}
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        draggable={!isPinned}
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
        style={{
          borderColor,
          // Slide this tab aside to open the gap the dragged tab will drop into.
          // A transform, so it never disturbs layout or the strip's scrollWidth.
          transform: dragOffset ? `translateX(${dragOffset}px)` : undefined
        }}
        className={`tab_tab ${isFirst ? 'tab_first' : ''} ${isActive ? 'tab_active' : ''} ${
          isFirst && isActive ? 'tab_firstActive' : ''
        } ${hasActivity ? 'tab_hasActivity' : ''} ${hasBell && !isActive ? 'tab_attention' : ''} ${
          isWebPane ? 'tab_webPane' : ''
        } ${isFirstRun ? 'tab_firstRun' : ''} ${props.isDragging ? 'tab_dragging' : ''} ${
          props.isDragSource ? 'tab_dragSource' : ''
        } ${isPinned ? 'tab_pinned' : ''}`}
        ref={ref}
      >
        <div
          className="tab_activeIndicator"
          style={{
            background: indicatorColor,
            // Show the pane-color strip on EVERY tab (dimmer when inactive) so a
            // tab's panes are identifiable at a glance, brightest on the active one.
            opacity: isActive ? 1 : 0.5
          }}
        />
        {props.customChildrenBefore}
        <span
          className={`tab_text ${isLast ? 'tab_textLast' : ''} ${isActive ? 'tab_textActive' : ''}`}
          onMouseUp={handleMouseUp}
        >
          {agentDotColor && (
            <span
              className={`tab_agentDot ${agentStatus?.working ? 'tab_agentDotPulse' : ''}`}
              style={{backgroundColor: agentDotColor}}
            />
          )}
          <span
            title={isPinned ? parsed.text || props.text : props.text !== displayText ? props.text : ''}
            className={`tab_textInner ${isActive ? 'tab_textInnerActive' : ''}`}
            onDoubleClick={handleDoubleClick}
          >
            {hasBell && <span className="tab_bell">🔔</span>}
            {renaming ? (
              <div className="tab_renameContainer">
                <input
                  ref={inputRef}
                  className="tab_renameInput"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={handleRenameKey}
                  onBlur={handleRenameSubmit}
                />
                <div className="tab_emojiPicker">
                  {PICKER_EMOJIS.map((emoji) => (
                    <span
                      key={emoji}
                      className="tab_pickerEmoji"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        const {text} = parseTabName(renameValue, isWebPane);
                        setRenameValue(`${emoji} ${text}`.trim());
                        inputRef.current?.focus();
                      }}
                    >
                      {emoji}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <span className="tab_textContent">
                {parsed.emoji ? <span className="tab_webIcon">{parsed.emoji}</span> : null}
                {isWebPane ? (
                  <span className="tab_webUrl" title={webUrl}>
                    {shownText}
                  </span>
                ) : (
                  shownText
                )}
              </span>
            )}
          </span>
        </span>
        {/* Browser-style: a pinned tab has no close button (middle-click still closes). */}
        {!isPinned && (
          <i className="tab_icon" onClick={props.onClose}>
            <svg className="tab_shape">
              <use xlinkHref="./renderer/assets/icons.svg#close-tab" />
            </svg>
          </i>
        )}
        {props.customChildren}
      </li>

      <style jsx>{`
        .tab_tab {
          color: var(--text-secondary);
          list-style-type: none;
          flex: 1 1 auto;
          min-width: 120px;
          max-width: 260px;
          position: relative;
          background: var(--bg-secondary);
          border-right: 0.5px solid var(--border-neutral);
          -webkit-app-region: no-drag;
          cursor: grab;
          font-family: var(--font-sans);
          font-size: 11px;
          font-weight: 400;
        }

        /* A pinned tab shrinks to comfortably fit its initials: no flex growth,
           no close-button gutter, content-sized width. */
        .tab_pinned {
          flex: 0 0 auto;
          min-width: 0;
          max-width: none;
          cursor: default;
        }
        .tab_pinned:active {
          cursor: default;
        }
        .tab_pinned .tab_text {
          width: auto;
          padding-left: 12px;
          padding-right: 12px;
        }
        .tab_pinned .tab_textInner {
          padding: 0;
        }

        .tab_activeIndicator {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 2px;
          transition: opacity 0.15s ease;
          pointer-events: none;
        }

        .tab_tab:active {
          cursor: grabbing;
        }

        /* On while any tab in the strip is being dragged. The slide is what makes
           the reorder readable — tabs move aside to show where the drop lands.

           Do NOT add pointer-events:none here. It looks right — the tabs are
           sliding under the cursor, so making them transparent to hit-testing
           seems tidy — but applying it to the drag source as dragstart fires
           makes Chromium abort the drag immediately: you get dragstart followed
           straight by dragend, no dragover, and tabs stop moving altogether.
           It is also unnecessary. tabs.tsx derives the drop index from the
           pointer's clientX against a snapshot taken at dragstart, never from
           the element under the cursor, and its handlers sit on the <ul>, which
           receives these events by bubbling whatever they hit first. */
        .tab_dragging {
          transition: transform 150ms cubic-bezier(0.2, 0, 0, 1);
        }

        /* The tab being carried. The OS draws the drag image under the cursor;
           this is the hole it left, dimmed so it reads as a placeholder. */
        .tab_dragSource {
          opacity: 0.4;
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

        /* A background tab with a pending consent/attention prompt pulses so the
           user notices a toast they can't see in the active tab. */
        .tab_attention {
          animation: tabAttention 1.1s ease-in-out infinite;
        }

        @keyframes tabAttention {
          0%,
          100% {
            background: var(--bg-secondary);
          }
          50% {
            background: var(--info-bg, rgba(0, 170, 255, 0.22));
          }
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
          text-overflow: ellipsis;
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

        .tab_renameContainer {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          width: 100%;
          z-index: 1000;
        }

        .tab_emojiPicker {
          position: absolute;
          top: calc(100% + 4px);
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          background: var(--bg-secondary);
          border: 0.5px solid var(--border-neutral);
          border-radius: 6px;
          padding: 6px;
          width: 180px;
          max-height: 100px;
          overflow-y: auto;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
          justify-content: center;
        }

        .tab_pickerEmoji {
          font-size: 14px;
          cursor: pointer;
          padding: 2px;
          border-radius: 4px;
          transition:
            background 0.15s,
            transform 0.1s;
          user-select: none;
        }

        .tab_pickerEmoji:hover {
          background: var(--border-neutral);
          transform: scale(1.2);
        }

        .tab_pickerEmoji:active {
          transform: scale(0.95);
        }
      `}</style>
    </>
  );
});

Tab.displayName = 'Tab';

export default Tab;
