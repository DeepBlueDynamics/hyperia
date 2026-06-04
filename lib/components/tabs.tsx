import React, {forwardRef, useEffect, useRef, useCallback, useState} from 'react';

import type {TabsProps} from '../../typings/hyper';
import {ipcRenderer} from '../utils/ipc';
import {decorate, getTabProps} from '../utils/plugins';

import Tab_ from './tab';

const Tab = decorate(Tab_, 'Tab');
const isMac = /Mac/.test(navigator.userAgent);

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

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [shellPath, setShellPath] = useState('');
  const [shellArgs, setShellArgs] = useState('');
  const [envVars, setEnvVars] = useState<{key: string; val: string}[]>([]);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');

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
      props.openNewTab(p.id as string);
    } else if (index === sortedProfiles.length) {
      setIsModalOpen(true);
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
          const {
            uid,
            title,
            isActive,
            hasActivity,
            hasBell,
            agentStatus,
            tabName,
            description,
            isWebPane,
            webUrl,
            paneColors,
            groupTabName,
            disableTitleInheritance
          } = tab;
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
            paneColors,
            groupTabName,
            disableTitleInheritance,
            onToggleTitleInheritance: () => (props as any).onToggleTitleInheritance?.(uid),
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
          onClick={() => props.openNewTab('picker')}
          aria-label="New tab"
          title="New Tab"
        >
          +
        </button>

        <button
          ref={chevronRef}
          className="tabs_chevronBtn"
          onClick={() => setIsOpen(!isOpen)}
          aria-haspopup="true"
          aria-expanded={isOpen}
          aria-label="Profiles list"
          title="Select Profile"
        >
          <svg viewBox="0 0 14 14" width="10" height="10">
            <path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>

        {isOpen && (
          <div className="new_tab_menu" ref={menuRef}>
            {sortedProfiles.map((p, idx) => (
              <div
                key={p.id}
                data-index={idx}
                tabIndex={0}
                className={`new_tab_menu_item ${p.isDefault ? 'new_tab_menu_item_default' : ''}`}
                onClick={() => triggerItem(idx)}
              >
                {p.displayName}
              </div>
            ))}
            <div className="new_tab_menu_divider" />
            <div
              data-index={sortedProfiles.length}
              tabIndex={0}
              className="new_tab_menu_item"
              onClick={() => triggerItem(sortedProfiles.length)}
            >
              Custom…
            </div>
            <div className="new_tab_menu_divider" />
            <div
              data-index={sortedProfiles.length + 1}
              tabIndex={0}
              className="new_tab_menu_item"
              onClick={() => triggerItem(sortedProfiles.length + 1)}
            >
              About
            </div>
          </div>
        )}

        <button
          className="tabs_newTabBtn"
          onClick={() => {
            try {
              ipcRenderer.send('new-window');
            } catch (err) {
              console.error(err);
            }
          }}
          aria-label="New window"
          title="New Window"
        >
          <svg viewBox="0 0 14 14" width="13" height="13">
            <rect x="1" y="3" width="10" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <rect x="3" y="1" width="10" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>

        <button
          className="tabs_newTabBtn"
          onClick={() => {
            try {
              ipcRenderer.send('new-sticky');
            } catch (err) {
              console.error(err);
            }
          }}
          aria-label="New sticky note"
          title="New Sticky"
        >
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
        </button>
      </div>

      {isMac && tabs.length > 1 && (
        <div
          key="shim"
          style={{borderColor}}
          className={`tabs_borderShim ${fullScreen ? 'tabs_borderShimUndo' : ''}`}
        />
      )}
      <div className="tabs_dragSpace" aria-hidden="true" />
      {props.customChildren}

      {isModalOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0, 0, 0, 0.65)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 99999,
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-sans)',
            cursor: 'default'
          }}
          onClick={() => setIsModalOpen(false)}
        >
          <div
            style={{
              width: '460px',
              background: 'var(--bg-secondary)',
              border: '0.5px solid var(--border-focus)',
              borderRadius: '6px',
              padding: '20px',
              boxShadow: '0 8px 30px rgba(0, 0, 0, 0.5)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
              <span style={{fontSize: '14px', fontWeight: 600}}>Create Custom Profile</span>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-tertiary)',
                  cursor: 'pointer',
                  fontSize: '16px'
                }}
              >
                ×
              </button>
            </div>

            {/* Profile Name */}
            <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
              <label style={{fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)'}}>Profile Name</label>
              <input
                type="text"
                placeholder="e.g. My Shell"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                style={{
                  background: 'var(--bg-primary)',
                  border: '0.5px solid var(--border-neutral)',
                  color: 'var(--text-primary)',
                  borderRadius: '4px',
                  padding: '8px 10px',
                  fontSize: '12px'
                }}
              />
            </div>

            {/* Shell Executable Path */}
            <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
              <label style={{fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)'}}>Shell Path</label>
              <div style={{display: 'flex', gap: '6px'}}>
                <input
                  type="text"
                  placeholder="e.g. /bin/bash or C:\Windows\System32\cmd.exe"
                  value={shellPath}
                  onChange={(e) => setShellPath(e.target.value)}
                  style={{
                    flex: 1,
                    background: 'var(--bg-primary)',
                    border: '0.5px solid var(--border-neutral)',
                    color: 'var(--text-primary)',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    fontSize: '12px',
                    fontFamily: 'var(--font-mono)'
                  }}
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const res = (await ipcRenderer.invoke('pick-shell-executable')) as any;
                      if (res) setShellPath(res);
                    } catch (err) {
                      console.error(err);
                    }
                  }}
                  style={{
                    background: 'var(--bg-tertiary)',
                    border: '0.5px solid var(--border-neutral)',
                    color: 'var(--text-primary)',
                    borderRadius: '4px',
                    padding: '0 10px',
                    fontSize: '12px',
                    cursor: 'pointer'
                  }}
                >
                  Browse…
                </button>
              </div>
            </div>

            {/* Shell Arguments */}
            <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
              <label style={{fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)'}}>Arguments (comma separated)</label>
              <input
                type="text"
                placeholder="e.g. --login, -i"
                value={shellArgs}
                onChange={(e) => setShellArgs(e.target.value)}
                style={{
                  background: 'var(--bg-primary)',
                  border: '0.5px solid var(--border-neutral)',
                  color: 'var(--text-primary)',
                  borderRadius: '4px',
                  padding: '8px 10px',
                  fontSize: '12px',
                  fontFamily: 'var(--font-mono)'
                }}
              />
            </div>

            {/* Environment Variables (Secrets Manager) */}
            <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
              <label style={{fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)'}}>Environment Variables</label>
              <div
                style={{
                  background: 'var(--bg-primary)',
                  border: '0.5px solid var(--border-neutral)',
                  borderRadius: '6px',
                  padding: '10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px'
                }}
              >
                {/* Env list */}
                <div style={{maxHeight: '80px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px'}}>
                  {envVars.length === 0 ? (
                    <span style={{fontSize: '10px', color: 'var(--text-tertiary)', fontStyle: 'italic'}}>No environment variables added.</span>
                  ) : (
                    envVars.map((v, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          background: 'var(--bg-secondary)',
                          borderRadius: '4px',
                          padding: '3px 8px',
                          fontSize: '11px',
                          fontFamily: 'var(--font-mono)'
                        }}
                      >
                        <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                          <span style={{color: 'var(--info-text)'}}>{v.key}</span>={v.val}
                        </span>
                        <button
                          type="button"
                          onClick={() => setEnvVars(envVars.filter((_, idx) => idx !== i))}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--danger-text)',
                            cursor: 'pointer',
                            fontSize: '14px'
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}
                </div>

                {/* Add inline form */}
                <div style={{display: 'flex', gap: '6px'}}>
                  <input
                    type="text"
                    placeholder="KEY"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                    style={{
                      flex: 1,
                      background: 'var(--bg-secondary)',
                      border: '0.5px solid var(--border-neutral)',
                      color: 'var(--text-primary)',
                      borderRadius: '4px',
                      padding: '6px 8px',
                      fontSize: '10px',
                      fontFamily: 'var(--font-mono)'
                    }}
                  />
                  <input
                    type="text"
                    placeholder="VALUE"
                    value={newVal}
                    onChange={(e) => setNewVal(e.target.value)}
                    style={{
                      flex: 1.5,
                      background: 'var(--bg-secondary)',
                      border: '0.5px solid var(--border-neutral)',
                      color: 'var(--text-primary)',
                      borderRadius: '4px',
                      padding: '6px 8px',
                      fontSize: '10px',
                      fontFamily: 'var(--font-mono)'
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const k = newKey.trim();
                      const v = newVal.trim();
                      if (k) {
                        setEnvVars([...envVars.filter(item => item.key !== k), {key: k, val: v}]);
                        setNewKey('');
                        setNewVal('');
                      }
                    }}
                    style={{
                      background: 'var(--info-text)',
                      color: 'var(--bg-primary)',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '0 10px',
                      fontSize: '10px',
                      cursor: 'pointer'
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div style={{display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px'}}>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                style={{
                  background: 'var(--bg-primary)',
                  border: '0.5px solid var(--border-neutral)',
                  color: 'var(--text-secondary)',
                  borderRadius: '4px',
                  padding: '8px 14px',
                  fontSize: '12px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!profileName.trim() || !shellPath.trim()}
                onClick={() => {
                  const pName = profileName.trim();
                  const sPath = shellPath.trim();
                  if (pName && sPath) {
                    const args = shellArgs
                      .split(',')
                      .map((a) => a.trim())
                      .filter(Boolean);
                    const envObj: Record<string, string> = {};
                    envVars.forEach((ev) => {
                      envObj[ev.key] = ev.val;
                    });
                    ipcRenderer.send('add-profile', {
                      name: pName,
                      shell: sPath,
                      shellArgs: args,
                      env: envObj
                    });
                    setIsModalOpen(false);
                    // Reset fields
                    setProfileName('');
                    setShellPath('');
                    setShellArgs('');
                    setEnvVars([]);
                  }
                }}
                style={{
                  background: (profileName.trim() && shellPath.trim()) ? 'var(--info-text)' : 'var(--border-neutral)',
                  color: 'var(--bg-primary)',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '8px 14px',
                  fontSize: '12px',
                  cursor: (profileName.trim() && shellPath.trim()) ? 'pointer' : 'default',
                  opacity: (profileName.trim() && shellPath.trim()) ? 1 : 0.6
                }}
              >
                Save Profile
              </button>
            </div>
          </div>
        </div>
      )}

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
          flex: 0 1 auto;
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
          flex: 1 1 auto;
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
          transition:
            background 0.15s,
            color 0.15s;
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
          transition:
            background 0.15s,
            color 0.15s;
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
          transition:
            background 0.15s ease,
            color 0.15s ease;
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
