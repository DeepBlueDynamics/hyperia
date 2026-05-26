import React, {forwardRef, useEffect, useRef, useCallback, useState} from 'react';

import type {TabsProps} from '../../typings/hyper';
import {decorate, getTabProps} from '../utils/plugins';
import {ipcRenderer} from '../utils/ipc';

import Tab_ from './tab';

const Tab = decorate(Tab_, 'Tab');
const isMac = /Mac/.test(navigator.userAgent);
const isWindows = /Windows/.test(navigator.userAgent);
const trailingDragWidth = isMac ? 0 : isWindows ? 200 : 160;

const Tabs = forwardRef<HTMLElement, TabsProps>((props, ref) => {
  const {tabs = [], borderColor, onChange, onClose, onDescribe, fullScreen} = props;
  const onMoveTab = (props as any).onMoveTab as ((fromUid: string, toIndex: number) => void) | undefined;
  const listRef = useRef<HTMLUListElement>(null);
  const dragUidRef = useRef<string | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Process, map, and sort profiles so the default is first
  const mappedProfiles = (props.profiles || []).map((p: any) => {
    const id = p.id || p.name;
    const displayName = p.displayName || p.name;
    const isDefault = p.default === true || id === props.defaultProfile || p.name === props.defaultProfile;
    return {
      id,
      displayName,
      isDefault,
      iconPath: p.iconPath,
      config: p.config
    };
  });

  const sortedProfiles = [...mappedProfiles].sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return 0;
  });

  const totalItemsCount = sortedProfiles.length + 2;

  const triggerItem = (index: number) => {
    setIsOpen(false);
    if (index < sortedProfiles.length) {
      const p = sortedProfiles[index];
      props.openNewTab(p.id);
    } else if (index === sortedProfiles.length) {
      try {
        ipcRenderer.send('edit-config-external');
      } catch (err) {
        console.error(err);
      }
    } else if (index === sortedProfiles.length + 1) {
      try {
        ipcRenderer.send('show-about');
      } catch (err) {
        console.error(err);
      }
    }
    chevronRef.current?.focus();
  };

  // Outside click dismiss
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        chevronRef.current &&
        !chevronRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Focus first menu item on open
  useEffect(() => {
    if (isOpen) {
      setFocusedIndex(0);
      setTimeout(() => {
        const itemEl = menuRef.current?.querySelector('[data-index="0"]') as HTMLDivElement | null;
        itemEl?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Keyboard navigation & focus trap inside popover
  useEffect(() => {
    if (!isOpen) return;

    const handleDocumentKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        chevronRef.current?.focus();
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        setFocusedIndex((prev) => {
          const next = (prev + 1) % totalItemsCount;
          const itemEl = menuRef.current?.querySelector(`[data-index="${next}"]`) as HTMLDivElement | null;
          itemEl?.focus();
          return next;
        });
      } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        setFocusedIndex((prev) => {
          const next = (prev - 1 + totalItemsCount) % totalItemsCount;
          const itemEl = menuRef.current?.querySelector(`[data-index="${next}"]`) as HTMLDivElement | null;
          itemEl?.focus();
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        triggerItem(focusedIndex);
      }
    };

    document.addEventListener('keydown', handleDocumentKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleDocumentKeyDown, true);
    };
  }, [isOpen, focusedIndex, sortedProfiles.length]);

  const updateScrollState = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Scroll active tab into view
  useEffect(() => {
    if (listRef.current) {
      const active = listRef.current.querySelector('.tab_active');
      if (active) {
        active.scrollIntoView({block: 'nearest', inline: 'nearest'});
      }
    }
    updateScrollState();
  }, [tabs.find((t) => t.isActive)?.uid, tabs.length, updateScrollState]);

  // Update scroll arrows on resize
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateScrollState]);

  // Horizontal scroll with mouse wheel
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (listRef.current) {
        listRef.current.scrollLeft += e.deltaY;
        updateScrollState();
      }
    },
    [updateScrollState]
  );

  const scrollBy = useCallback(
    (dir: 1 | -1) => {
      if (listRef.current) {
        listRef.current.scrollBy({left: dir * 120, behavior: 'smooth'});
        setTimeout(updateScrollState, 150);
      }
    },
    [updateScrollState]
  );

  // Tab drag-to-reorder
  const handleDragStart = useCallback((uid: string) => {
    dragUidRef.current = uid;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (targetUid: string) => {
      const fromUid = dragUidRef.current;
      dragUidRef.current = null;
      if (!fromUid || fromUid === targetUid || !onMoveTab) return;
      const targetIndex = tabs.findIndex((t) => t.uid === targetUid);
      if (targetIndex >= 0) {
        onMoveTab(fromUid, targetIndex);
      }
    },
    [tabs, onMoveTab]
  );

  const handleDragEnd = useCallback(() => {
    dragUidRef.current = null;
  }, []);

  return (
    <nav className="tabs_nav" ref={ref}>
      {props.customChildrenBefore}
      {canScrollLeft && (
        <button className="tabs_scrollBtn tabs_scrollLeft" onClick={() => scrollBy(-1)} aria-label="Scroll tabs left">
          ‹
        </button>
      )}
      <ul
        key="list"
        ref={listRef}
        onWheel={handleWheel}
        onScroll={updateScrollState}
        className={`tabs_list ${fullScreen && isMac ? 'tabs_fullScreen' : ''}`}
      >
        {tabs.map((tab, i) => {
          const {uid, title, isActive, hasActivity, hasBell, agentStatus, tabName, description, isWebPane, webUrl} =
            tab;
          const tabProps = getTabProps(tab, props, {
            text: tabName || title || 'Shell',
            tabName: tabName || title || 'Shell',
            description: description || '',
            uid,
            isFirst: i === 0,
            isLast: tabs.length - 1 === i,
            borderColor,
            isActive,
            hasActivity,
            hasBell,
            agentStatus,
            isWebPane,
            webUrl,
            defaultProfile: props.defaultProfile,
            onSelect: onChange.bind(null, uid),
            onClose: onClose.bind(null, uid),
            onDescribe: (desc: string) => onDescribe(uid, desc),
            onDragStart: () => handleDragStart(uid),
            onDragOver: handleDragOver,
            onDrop: () => handleDrop(uid),
            onDragEnd: handleDragEnd
          });
          return <Tab key={`tab-${uid}`} {...tabProps} />;
        })}
      </ul>
      {canScrollRight && (
        <button className="tabs_scrollBtn tabs_scrollRight" onClick={() => scrollBy(1)} aria-label="Scroll tabs right">
          ›
        </button>
      )}

      <div className="tabs_newTabPair">
        <button
          className="tabs_newTabBtn"
          onClick={() => props.openNewTab(props.defaultProfile)}
          aria-label="New tab"
          title="New Tab"
        >
          +
        </button>
        <button
          ref={chevronRef}
          className="tabs_chevronBtn"
          onClick={() => setIsOpen(!isOpen)}
          aria-label="New tab options"
          aria-haspopup="menu"
          aria-expanded={isOpen}
        >
          <svg viewBox="0 0 10 10" width="8" height="8">
            <path
              d="M1 3.5l4 4 4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {isOpen && (
          <div className="new_tab_menu" role="menu" ref={menuRef}>
            {sortedProfiles.map((p, i) => (
              <div
                key={p.id}
                className={`new_tab_menu_item ${p.isDefault ? 'new_tab_menu_item_default' : ''}`}
                onClick={() => triggerItem(i)}
                onMouseEnter={() => setFocusedIndex(i)}
                tabIndex={-1}
                data-index={i}
                role="menuitem"
              >
                {p.iconPath ? (
                  <img
                    src={p.iconPath}
                    alt=""
                    style={{
                      width: '12px',
                      height: '12px',
                      marginRight: '8px',
                      objectFit: 'contain',
                      opacity: 0.8
                    }}
                  />
                ) : (
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    style={{
                      marginRight: '8px',
                      opacity: 0.7,
                      flexShrink: 0
                    }}
                  >
                    <path
                      d="M2 3h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v6h10V5H3zm2 1.5l2 1.5-2 1.5v-3zm3.5 3h3v1h-3v-1z"
                      fill="currentColor"
                    />
                  </svg>
                )}
                <span style={{ flexGrow: 1, textOverflow: 'ellipsis', overflow: 'hidden' }}>{p.displayName}</span>
                {p.isDefault && (
                  <svg viewBox="0 0 16 16" width="12" height="12" style={{ marginLeft: 'auto', color: '#0096ff' }}>
                    <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z" fill="none" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
                )}
              </div>
            ))}
            <div className="new_tab_menu_divider" />
            <div
              className="new_tab_menu_item"
              onClick={() => triggerItem(sortedProfiles.length)}
              onMouseEnter={() => setFocusedIndex(sortedProfiles.length)}
              tabIndex={-1}
              data-index={sortedProfiles.length}
              role="menuitem"
            >
              <svg viewBox="0 0 16 16" width="12" height="12" style={{ marginRight: '8px', opacity: 0.7 }}>
                <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.86z" fill="currentColor"/>
              </svg>
              Settings…
            </div>
            <div
              className="new_tab_menu_item"
              onClick={() => triggerItem(sortedProfiles.length + 1)}
              onMouseEnter={() => setFocusedIndex(sortedProfiles.length + 1)}
              tabIndex={-1}
              data-index={sortedProfiles.length + 1}
              role="menuitem"
            >
              <svg viewBox="0 0 16 16" width="12" height="12" style={{ marginRight: '8px', opacity: 0.7 }}>
                <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" fill="currentColor"/>
                <path d="M8.93 6.588l-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" fill="currentColor"/>
              </svg>
              About
            </div>
          </div>
        )}
      </div>

      {isMac && tabs.length > 1 && (
        <div
          key="shim"
          style={{borderColor}}
          className={`tabs_borderShim ${fullScreen ? 'tabs_borderShimUndo' : ''}`}
        />
      )}
      {!isMac && <div className="tabs_dragSpace" aria-hidden="true" />}
      {props.customChildren}

      <style jsx>{`
        .tabs_nav {
          font-family: var(--font-sans);
          font-size: 11px;
          height: 34px;
          line-height: 34px;
          vertical-align: middle;
          color: var(--text-secondary);
          cursor: default;
          position: relative;
          -webkit-user-select: none;
          display: flex;
          flex-flow: row;
          align-items: stretch;
          flex: 1 1 auto;
          min-width: 0;
          -webkit-app-region: drag;
        }

        .tabs_list {
          max-height: 34px;
          display: flex;
          flex-flow: row;
          margin: 0 0 0 ${isMac ? '76px' : '0'};
          padding: 0;
          flex: 1 1 auto;
          min-width: 0;
          overflow-x: auto;
          overflow-y: hidden;
          scrollbar-width: none;
          list-style: none;
          -webkit-app-region: drag;
        }

        .tabs_list::-webkit-scrollbar {
          display: none;
        }

        .tabs_fullScreen {
          margin-left: -1px;
        }

        .tabs_dragSpace {
          flex: 0 0 ${trailingDragWidth}px;
          min-width: ${trailingDragWidth}px;
          -webkit-app-region: drag;
        }

        .tabs_scrollBtn {
          flex: 0 0 auto;
          width: 20px;
          height: 34px;
          background: var(--bg-secondary);
          border: none;
          border-right: 0.5px solid var(--border-neutral);
          color: var(--text-secondary);
          font-size: 16px;
          line-height: 34px;
          cursor: pointer;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          -webkit-app-region: no-drag;
          z-index: 1;
          transition:
            color 0.15s,
            background 0.15s;
        }

        .tabs_scrollBtn:hover {
          color: var(--text-primary);
          background: var(--bg-tertiary);
        }

        .tabs_scrollRight {
          border-right: none;
          border-left: 0.5px solid var(--border-neutral);
        }

        .tabs_borderShim {
          position: absolute;
          width: 76px;
          bottom: 0;
          border-color: var(--border-neutral);
          border-bottom-style: solid;
          border-bottom-width: 0.5px;
        }

        .tabs_borderShimUndo {
          border-bottom-width: 0px;
        }

        .tabs_newTabPair {
          display: flex;
          align-items: center;
          height: 34px;
          background: transparent;
          border-left: 0.5px solid var(--border-neutral);
          -webkit-app-region: no-drag;
          z-index: 10;
          position: relative;
        }

        .tabs_newTabBtn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 34px;
          cursor: pointer;
          color: var(--text-secondary);
          background: transparent;
          border: none;
          padding: 0;
          font-size: 18px;
          font-weight: var(--weight-regular);
          transition: background 0.15s, color 0.15s;
          outline: none;
        }

        .tabs_newTabBtn:hover,
        .tabs_newTabBtn:focus {
          color: var(--text-primary);
          background: var(--bg-tertiary);
        }

        .tabs_chevronBtn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 34px;
          cursor: pointer;
          color: var(--text-secondary);
          background: transparent;
          border: none;
          padding: 0;
          transition: background 0.15s, color 0.15s;
          outline: none;
        }

        .tabs_chevronBtn:hover,
        .tabs_chevronBtn:focus {
          color: var(--text-primary);
          background: var(--bg-tertiary);
        }

        .new_tab_menu {
          position: absolute;
          top: 100%;
          right: 0;
          margin-top: 4px;
          min-width: 180px;
          background: var(--bg-secondary);
          border: 0.5px solid var(--border-neutral);
          border-radius: 4px;
          z-index: 1000;
          padding: 6px 0;
          -webkit-app-region: no-drag;
        }

        .new_tab_menu_item {
          display: flex;
          align-items: center;
          padding: 8px 12px;
          font-size: 11px;
          color: var(--text-secondary);
          cursor: pointer;
          white-space: nowrap;
          outline: none;
          transition: background 0.15s ease, color 0.15s ease;
          font-weight: var(--weight-regular);
        }

        .new_tab_menu_item:hover,
        .new_tab_menu_item:focus {
          background: var(--info-bg);
          color: var(--text-primary);
        }

        .new_tab_menu_item_default {
          font-weight: var(--weight-medium);
        }

        .new_tab_menu_divider {
          height: 0.5px;
          background: var(--border-neutral);
          margin: 6px 0;
        }
      `}</style>
    </nav>
  );
});

Tabs.displayName = 'Tabs';

export default Tabs;
