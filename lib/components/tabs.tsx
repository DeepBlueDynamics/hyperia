import React, {forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useState} from 'react';

import type {TabsProps} from '../../typings/hyper';
import rpc from '../rpc';
import {ipcRenderer} from '../utils/ipc';
import {decorate, getTabProps} from '../utils/plugins';
import {dropIndexForX, reorderOffsets} from '../utils/tab-drag';
import type {TabMetrics} from '../utils/tab-drag';
import {nextScrollStop} from '../utils/tab-scroll';
import type {TabSpan} from '../utils/tab-scroll';

import Tab_ from './tab';

const Tab = decorate(Tab_, 'Tab');
const isMac = /Mac/.test(navigator.userAgent);

const Tabs = forwardRef<HTMLElement, TabsProps>((props, ref) => {
  const {tabs = [], borderColor, onChange, onClose, onDescribe, fullScreen} = props;
  const {onMoveTab} = props;
  const listRef = useRef<HTMLUListElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [shellPath, setShellPath] = useState('');
  const [shellArgs, setShellArgs] = useState('');
  const [envVars, setEnvVars] = useState<{key: string; val: string}[]>([]);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');

  const updateScrollState = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Keep the active tab fully visible. Adjusts ONLY the list's scrollLeft:
  // scrollIntoView also scrolls every scrollable ancestor (overflow:hidden header
  // containers included), which shifted the whole strip and left the first tab
  // half cut off. And one pass right after render isn't enough: that same render
  // turns the 20px scroll arrows on, which narrows and shifts the list AFTER the
  // scroll, leaving the new tab half hidden. So the reveal stays pending briefly
  // and is re-applied after the arrows render and on resize, until the user
  // scrolls by hand. A tab added at the end pins the strip to the far right.
  const pendingReveal = useRef<{mode: 'end' | 'active'; until: number} | null>(null);
  const prevTabCount = useRef(tabs.length);
  const applyReveal = useCallback(() => {
    const el = listRef.current;
    const pending = pendingReveal.current;
    if (!el || !pending) return;
    if (Date.now() > pending.until) {
      pendingReveal.current = null;
      return;
    }
    if (pending.mode === 'end') {
      el.scrollLeft = el.scrollWidth - el.clientWidth;
      return;
    }
    const active = el.querySelector<HTMLElement>('.tab_active');
    if (!active) return;
    const listRect = el.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.left < listRect.left) {
      el.scrollLeft += tabRect.left - listRect.left;
    } else if (tabRect.right > listRect.right) {
      el.scrollLeft += tabRect.right - listRect.right;
    }
  }, []);
  const cancelReveal = useCallback(() => {
    pendingReveal.current = null;
  }, []);

  const activeUid = tabs.find((t) => t.isActive)?.uid;
  useLayoutEffect(() => {
    const added = tabs.length > prevTabCount.current;
    prevTabCount.current = tabs.length;
    const activeIsLast = tabs.length > 0 && !!tabs[tabs.length - 1].isActive;
    pendingReveal.current = {mode: added && activeIsLast ? 'end' : 'active', until: Date.now() + 600};
    applyReveal();
    updateScrollState();
    const raf = requestAnimationFrame(() => {
      applyReveal();
      updateScrollState();
    });
    return () => cancelAnimationFrame(raf);
  }, [activeUid, tabs.length, applyReveal, updateScrollState]);

  // The scroll arrows appearing/disappearing resizes the list; re-apply after that render.
  useLayoutEffect(() => {
    applyReveal();
  }, [canScrollLeft, canScrollRight, applyReveal]);

  // Update scroll arrows (and any pending reveal) on resize
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      applyReveal();
      updateScrollState();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyReveal, updateScrollState]);

  // Whole-tab scrolling. Arrows and the wheel land the strip's left edge on a
  // tab boundary, whatever the tabs' widths (a fixed pixel step used to stop
  // mid-tab one click and a whole tab the next). Each step fully reveals the
  // tab cut off at that edge, plus the one after it when more than half of the
  // cut-off tab was already showing: see nextScrollStop.
  // `scrollTarget` is where an in-flight smooth scroll is headed, so rapid
  // clicks step from there instead of from a half-animated scrollLeft.
  const scrollTarget = useRef<number | null>(null);
  const scrollTargetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabSpans = (el: HTMLUListElement): TabSpan[] => {
    const origin = el.getBoundingClientRect().left - el.scrollLeft;
    return Array.from(el.querySelectorAll<HTMLElement>('.tab_tab')).map((tab) => {
      const r = tab.getBoundingClientRect();
      return {left: Math.round(r.left - origin), right: Math.round(r.right - origin)};
    });
  };
  const stepTabs = useCallback(
    (dir: 1 | -1) => {
      const el = listRef.current;
      if (!el) return;
      cancelReveal();
      const from = scrollTarget.current ?? el.scrollLeft;
      const next = nextScrollStop(tabSpans(el), from, el.clientWidth, el.scrollWidth - el.clientWidth, dir);
      if (next === null) return;
      scrollTarget.current = next;
      el.scrollTo({left: next, behavior: 'smooth'});
      if (scrollTargetTimer.current) clearTimeout(scrollTargetTimer.current);
      scrollTargetTimer.current = setTimeout(() => {
        scrollTarget.current = null;
        updateScrollState();
      }, 350);
    },
    [cancelReveal, updateScrollState]
  );

  // Mouse wheel: one tab per notch. Trackpads send many small deltas, so they
  // accumulate until they amount to a notch before stepping.
  const wheelAccum = useRef(0);
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      if (Math.sign(delta) !== Math.sign(wheelAccum.current)) wheelAccum.current = 0;
      wheelAccum.current += delta;
      if (Math.abs(wheelAccum.current) < 40) return;
      wheelAccum.current = 0;
      stepTabs(delta > 0 ? 1 : -1);
    },
    [stepTabs]
  );

  const scrollBy = stepTabs;

  // Scroll-arrow hover hints. They're DOM and drop over the pane area, where a
  // native web pane would paint on top of them, so web panes are suppressed
  // (frozen still) while an arrow is hovered, the same as the +/window/sticky
  // cluster below. An arrow can unmount under the cursor (scrolled to the end),
  // which skips mouseleave, so its disappearance also releases the suppression.
  const hoveredArrow = useRef<'left' | 'right' | null>(null);
  const setWebPanesSuppressed = useCallback((suppressed: boolean) => {
    try {
      ipcRenderer.send('web-panes:suppress', {suppressed});
    } catch {
      /* ipc not ready */
    }
  }, []);
  const arrowHover = (dir: 'left' | 'right') => ({
    onMouseEnter: () => {
      hoveredArrow.current = dir;
      setWebPanesSuppressed(true);
    },
    onMouseLeave: () => {
      hoveredArrow.current = null;
      setWebPanesSuppressed(false);
    }
  });
  useEffect(() => {
    const gone =
      (hoveredArrow.current === 'left' && !canScrollLeft) || (hoveredArrow.current === 'right' && !canScrollRight);
    if (gone) {
      hoveredArrow.current = null;
      setWebPanesSuppressed(false);
    }
  }, [canScrollLeft, canScrollRight, setWebPanesSuppressed]);
  useEffect(
    () => () => {
      if (hoveredArrow.current) setWebPanesSuppressed(false);
    },
    [setWebPanesSuppressed]
  );

  // Tab drag-to-reorder.
  //
  // `drag.to` is the index the carried tab would land on if dropped now, so the
  // strip can open the gap live instead of only committing on drop. It is
  // derived from the pointer's x measured against `metricsRef` — a snapshot of
  // the tabs' geometry taken at dragstart — and never from which tab the pointer
  // happens to be over. That distinction matters: the tabs are being translated
  // out of the way underneath the cursor, so hit-testing them would feed the
  // positions we just produced back into the calculation that produced them, and
  // the gap would oscillate between two slots.
  const [drag, setDrag] = useState<{uid: string; from: number; to: number} | null>(null);
  const metricsRef = useRef<TabMetrics | null>(null);

  // Left edge of the list's scroll content, in viewport coordinates. Measuring
  // against this rather than against the viewport keeps the snapshot valid if
  // the strip is wheel-scrolled mid-drag.
  const contentOrigin = (list: HTMLUListElement) => list.getBoundingClientRect().left - list.scrollLeft;

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return null;
    const origin = contentOrigin(list);
    const starts: number[] = [];
    const widths: number[] = [];
    list.querySelectorAll<HTMLElement>('.tab_tab').forEach((el) => {
      const rect = el.getBoundingClientRect();
      starts.push(rect.left - origin);
      widths.push(rect.width);
    });
    return {starts, widths};
  }, []);

  const indexForX = useCallback((clientX: number, from: number) => {
    const list = listRef.current;
    const metrics = metricsRef.current;
    if (!list || !metrics) return from;
    return dropIndexForX(metrics, from, clientX - contentOrigin(list));
  }, []);

  const dragOffsets = useMemo(() => {
    const metrics = metricsRef.current;
    if (!drag || !metrics) return null;
    return reorderOffsets(metrics, drag.from, drag.to);
  }, [drag]);

  // Pinned tabs occupy the leftmost slots and sit outside drag-to-reorder:
  // they can't be picked up, and an unpinned tab can't drop among them.
  const pinnedCount = useMemo(() => tabs.filter((t) => t.pinned).length, [tabs]);

  // Tab-scoped saved workspaces for the + menu (#183) — bookmark-style rows
  // beneath the layout presets. Refreshed on hover so a save made moments ago
  // shows up without any store plumbing.
  const [savedTabWorkspaces, setSavedTabWorkspaces] = useState<
    Array<{name: string; savedAt: string; panes: number; webPanes: number}>
  >([]);
  // Two-click delete: first click on a row's trash arms it (name here), second
  // confirms. Reset when the + menu closes (mouseleave) so it never lingers.
  const [confirmDeleteWs, setConfirmDeleteWs] = useState<string | null>(null);
  // rpc.emit THROWS 'Not ready' until the ipc channel id arrives (see
  // web-url-sync.ts) — and this component mounts before that. Guard every
  // emit; the hover refresh covers whatever an early fetch misses.
  const requestWorkspaceList = useCallback(() => {
    try {
      rpc.emit('list tab workspaces');
    } catch {
      /* rpc not ready yet — the next hover will fetch */
    }
  }, []);
  useEffect(() => {
    const onList = ({rows}: {rows: Array<{name: string; savedAt: string; panes: number; webPanes: number}>}) => {
      setSavedTabWorkspaces(rows);
    };
    rpc.on('tab workspaces list', onList);
    requestWorkspaceList();
    return () => {
      rpc.removeListener('tab workspaces list', onList);
    };
  }, [requestWorkspaceList]);

  const handleDragStart = useCallback(
    (uid: string, index: number, e: React.DragEvent) => {
      if (tabs[index]?.pinned) {
        e.preventDefault();
        return;
      }
      metricsRef.current = measure();
      // A private type, deliberately not text/plain: nothing reads this payload
      // (the reorder runs off `drag` state), and text/plain would make a tab
      // released over a web pane paste the uid into whatever field is under the
      // cursor. This mirrors the pane-band's application/x-hyperia-pane.
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-hyperia-tab', uid);
      setDrag({uid, from: index, to: index});
    },
    [measure, tabs]
  );

  // Bound on the <ul>, not on each tab: whichever tab the pointer is actually
  // over, the event bubbles up to here. That is deliberate — the tabs are being
  // translated under the cursor, and the handler must not care which one it hit,
  // only where the pointer is. (Making the tabs pointer-events:none to force the
  // events here directly kills the native drag outright; see tab.tsx.)
  const handleListDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const to = Math.max(indexForX(e.clientX, drag.from), pinnedCount);
      if (to !== drag.to) {
        setDrag({...drag, to});
      }
    },
    [drag, indexForX, pinnedCount]
  );

  const endDrag = useCallback(() => {
    setDrag(null);
    metricsRef.current = null;
  }, []);

  const handleListDrop = useCallback(
    (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      // A tab can close on its own mid-drag — a shell exits, an agent finishes —
      // which shifts every index the dragstart snapshot was built from. Commit
      // only while the tab that was picked up is still where we left it.
      if (drag.to !== drag.from && tabs[drag.from]?.uid === drag.uid) {
        onMoveTab?.(drag.uid, drag.to);
      }
      // Clearing the drag in the same batch as the reorder drops .tab_dragging,
      // and with it the transition, on the very commit that renders the new
      // order. The transforms go to zero with no animation, so the tabs don't
      // visibly slide back through the positions they just settled into.
      endDrag();
    },
    [drag, tabs, onMoveTab, endDrag]
  );

  return (
    <nav className="tabs_nav" ref={ref}>
      {props.customChildrenBefore}
      {canScrollLeft && (
        <div className="tabs_newTab_tooltip_trigger tabs_scrollTrigger" {...arrowHover('left')}>
          <button className="tabs_scrollBtn tabs_scrollLeft" onClick={() => scrollBy(-1)} aria-label="Scroll tabs left">
            ‹
          </button>
          <div className="tabs_newTab_tooltip tabs_btnTip tabs_scrollTip tabs_scrollTipLeft">
            Scroll tabs left, or use the scroll wheel
          </div>
        </div>
      )}
      <ul
        key="list"
        ref={listRef}
        onWheel={handleWheel}
        onScroll={updateScrollState}
        onDragOver={handleListDragOver}
        onDrop={handleListDrop}
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
            manualTabName,
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
            manualTabName,
            disableTitleInheritance,
            isPinned: !!tab.pinned,
            onPin: () => props.onPinTab?.(uid, !tab.pinned),
            onToggleTitleInheritance: () => (props as any).onToggleTitleInheritance?.(uid),
            defaultProfile: props.defaultProfile,
            onSelect: onChange.bind(null, uid),
            onClose: onClose.bind(null, uid),
            onDescribe: (desc: string) => onDescribe(uid, desc),
            onDragStart: (e: React.DragEvent) => handleDragStart(uid, i, e),
            // Fires on the source tab even after pointer-events are dropped, and
            // covers the drops the <ul> never sees — released outside the strip,
            // or cancelled with Escape.
            onDragEnd: endDrag,
            isDragging: drag !== null,
            isDragSource: drag?.uid === uid,
            dragOffset: dragOffsets?.[i] ?? 0
          });
          return <Tab key={`tab-${uid}`} {...tabProps} />;
        })}
      </ul>
      {canScrollRight && (
        <div className="tabs_newTab_tooltip_trigger tabs_scrollTrigger" {...arrowHover('right')}>
          <button
            className="tabs_scrollBtn tabs_scrollRight"
            onClick={() => scrollBy(1)}
            aria-label="Scroll tabs right"
          >
            ›
          </button>
          <div className="tabs_newTab_tooltip tabs_btnTip tabs_scrollTip">
            Scroll tabs right, or use the scroll wheel
          </div>
        </div>
      )}

      {/* These tab-bar buttons' hover menus (the + layout/workspace dropdown,
          New Window, New Stickys tooltips) drop DOWN over the pane area, where a
          native web pane would paint on top of them. Suppress the window's web
          panes (frozen-still — no blank) while the cursor is over the cluster, so
          the menus render above; restore on leave. */}
      <div
        className="tabs_newTabPair"
        onMouseEnter={() => {
          try {
            ipcRenderer.send('web-panes:suppress', {suppressed: true});
          } catch {
            /* ipc not ready */
          }
        }}
        onMouseLeave={() => {
          setConfirmDeleteWs(null);
          try {
            ipcRenderer.send('web-panes:suppress', {suppressed: false});
          } catch {
            /* ipc not ready */
          }
        }}
      >
        {/* New-tab "+" with its quick-layout hover menu (#140). The menu was
            dropped when 6a93c13e redesigned this cluster into the +/window/sticky
            trio — it deleted the JSX but left the CSS (.tabs_newTab_tooltip /
            .tabs_layout_grid …) orphaned. Restored here: hovering + reveals the
            layout presets; each opens a new grouped tab pre-split via the same
            rpc('new', {layoutPattern}) path (sessions.ts → openLayout), still wired. */}
        <div
          className="tabs_newTab_tooltip_trigger"
          style={{position: 'relative', display: 'inline-flex'}}
          onMouseEnter={requestWorkspaceList}
        >
          <button
            className="tabs_newTabBtn"
            onClick={() => props.openNewTab('picker')}
            aria-label="New tab"
            title="New Tab"
          >
            +
          </button>
          <div className="tabs_newTab_tooltip" style={{minWidth: '200px'}}>
            <div
              style={{
                fontSize: '11px',
                color: 'var(--text-primary)',
                fontWeight: 600,
                marginBottom: '8px',
                textAlign: 'center'
              }}
            >
              New Tab Layouts
            </div>
            <div className="tabs_layout_grid">
              <div
                className="tabs_layout_item"
                onClick={() => rpc.emit('new', {isNewGroup: true, profile: 'picker', layoutPattern: '3cols'} as any)}
                title="3 Columns"
              >
                <div className="layout-preview-box l-3cols">
                  <div />
                  <div />
                  <div />
                </div>
              </div>
              <div
                className="tabs_layout_item"
                onClick={() => rpc.emit('new', {isNewGroup: true, profile: 'picker', layoutPattern: '3rows'} as any)}
                title="3 Rows"
              >
                <div className="layout-preview-box l-3rows">
                  <div />
                  <div />
                  <div />
                </div>
              </div>
              <div
                className="tabs_layout_item"
                onClick={() => rpc.emit('new', {isNewGroup: true, profile: 'picker', layoutPattern: 'grid2x2'} as any)}
                title="Grid 2x2"
              >
                <div className="layout-preview-box l-grid2x2">
                  <div />
                  <div />
                  <div />
                  <div />
                </div>
              </div>
            </div>
            {/* Bookmark-style tab-workspaces (#183): saved via a tab's
                right-click menu, restored ADDITIVELY into a new tab here. */}
            {savedTabWorkspaces.length > 0 && (
              <>
                <div
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-primary)',
                    fontWeight: 600,
                    margin: '10px 0 6px',
                    textAlign: 'center'
                  }}
                >
                  Saved Tabs
                </div>
                <div style={{maxHeight: '160px', overflowY: 'auto'}}>
                  {savedTabWorkspaces.map((ws) => (
                    <div
                      key={ws.name}
                      onClick={() => rpc.emit('restore tab workspace', {name: ws.name})}
                      title={`Restore into a new tab · ${ws.panes} pane${ws.panes === 1 ? '' : 's'}${
                        ws.webPanes ? ` + ${ws.webPanes} web` : ''
                      }`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '4px 6px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        color: 'var(--text-primary)'
                      }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--bg-tertiary)')}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
                    >
                      <i className="ti ti-bookmark" style={{fontSize: '12px', color: 'var(--info-text)'}} />
                      <span style={{flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                        {ws.name}
                      </span>
                      <span style={{color: 'var(--text-tertiary)', flexShrink: 0}}>{ws.panes + ws.webPanes}▢</span>
                      {confirmDeleteWs === ws.name ? (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            try {
                              rpc.emit('delete tab workspace', {name: ws.name});
                            } catch {
                              /* ipc not ready */
                            }
                            setConfirmDeleteWs(null);
                          }}
                          title="Confirm delete"
                          style={{
                            color: 'var(--danger-text, #ff5c57)',
                            flexShrink: 0,
                            minWidth: '52px',
                            textAlign: 'right',
                            whiteSpace: 'nowrap',
                            cursor: 'pointer',
                            fontWeight: 600
                          }}
                        >
                          Delete?
                        </span>
                      ) : (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteWs(ws.name);
                          }}
                          title="Delete this saved tab"
                          style={{
                            color: 'var(--text-tertiary)',
                            flexShrink: 0,
                            minWidth: '52px',
                            textAlign: 'right',
                            cursor: 'pointer'
                          }}
                        >
                          <i className="ti ti-trash" style={{fontSize: '12px'}} />
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Wrapped in the shared tooltip trigger so hovering shows an instant
            styled label instead of waiting ~1s on the OS `title` tooltip. The
            `title` attr is dropped so the two don't stack; aria-label carries
            the accessible name. */}
        <div className="tabs_newTab_tooltip_trigger">
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
          >
            <svg viewBox="0 0 14 14" width="13" height="13">
              <rect x="1" y="3" width="10" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <rect x="3" y="1" width="10" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <div className="tabs_newTab_tooltip tabs_btnTip">New Window</div>
        </div>

        <div className="tabs_newTab_tooltip_trigger">
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
          <div className="tabs_newTab_tooltip tabs_btnTip">New Stickys</div>
        </div>
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
                  onClick={() => {
                    void (async () => {
                      try {
                        const res = (await ipcRenderer.invoke('pick-shell-executable')) as any;
                        if (res) setShellPath(res);
                      } catch (err) {
                        console.error(err);
                      }
                    })();
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
              <label style={{fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)'}}>
                Arguments (comma separated)
              </label>
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
              <label style={{fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)'}}>
                Environment Variables
              </label>
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
                <div
                  style={{maxHeight: '80px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px'}}
                >
                  {envVars.length === 0 ? (
                    <span style={{fontSize: '10px', color: 'var(--text-tertiary)', fontStyle: 'italic'}}>
                      No environment variables added.
                    </span>
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
                        setEnvVars([...envVars.filter((item) => item.key !== k), {key: k, val: v}]);
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
                  background: profileName.trim() && shellPath.trim() ? 'var(--info-text)' : 'var(--border-neutral)',
                  color: 'var(--bg-primary)',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '8px 14px',
                  fontSize: '12px',
                  cursor: profileName.trim() && shellPath.trim() ? 'pointer' : 'default',
                  opacity: profileName.trim() && shellPath.trim() ? 1 : 0.6
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

        /* Arrow + its hover hint. The wrapper takes the arrow's place as a
           fixed-size flex item; the hint drops below the tab bar. */
        .tabs_scrollTrigger {
          flex: 0 0 auto;
          -webkit-app-region: no-drag;
        }
        /* Compound selectors: .tabs_newTab_tooltip / .tabs_btnTip are declared
           later in this sheet and would otherwise win at equal specificity. */
        .tabs_newTab_tooltip.tabs_scrollTip {
          pointer-events: none;
          z-index: 1001;
        }
        /* The left arrow sits at the strip's left edge, so its hint anchors left. */
        .tabs_btnTip.tabs_scrollTipLeft {
          left: 0;
          right: auto;
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

        .tabs_newTab_tooltip_trigger {
          position: relative;
          display: inline-flex;
        }

        .tabs_newTab_tooltip {
          display: none;
          position: absolute;
          top: 34px;
          left: 0;
          background: var(--bg-primary);
          border: 0.5px solid var(--border-neutral);
          border-radius: var(--radius-4);
          padding: var(--space-8, 8px) var(--space-12, 12px);
          white-space: nowrap;
          z-index: 1000;
          text-align: left;
          pointer-events: auto;
          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
        }

        .tabs_newTab_tooltip::before {
          content: '';
          position: absolute;
          top: -12px;
          left: 4px;
          width: 20px;
          height: 12px;
          background: transparent;
        }

        .tabs_newTab_tooltip_trigger:hover .tabs_newTab_tooltip {
          display: block;
        }

        /* Compact label variant for the icon buttons. Anchored to the RIGHT
           edge: these sit at the end of the tab bar, so a left-anchored
           tooltip would run off the window. */
        .tabs_btnTip {
          left: auto;
          right: 0;
          top: 32px;
          padding: var(--space-4) var(--space-8);
          font-size: 11px;
          font-weight: var(--weight-regular);
          color: var(--text-primary);
          box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
        }

        /* Layouts grid */
        .tabs_layout_grid {
          display: grid;
          grid-template-columns: repeat(3, max-content);
          justify-content: center;
          gap: 8px;
          padding: 4px;
        }

        .tabs_layout_item {
          cursor: pointer;
          border-radius: 4px;
          border: 1px solid var(--border-neutral);
          padding: 4px;
          background: rgba(255, 255, 255, 0.02);
          transition: all 0.15s ease;
        }

        .tabs_layout_item:hover {
          border-color: var(--accent-primary, #6ea8fe);
          background: rgba(110, 168, 254, 0.15);
          transform: translateY(-1px);
        }

        .layout-preview-box {
          width: 48px;
          height: 32px;
          background: rgba(0, 0, 0, 0.25);
          border-radius: 2px;
          overflow: hidden;
          display: flex;
          gap: 1px;
          border: 0.5px solid rgba(255, 255, 255, 0.15);
        }

        .layout-preview-box div {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 1px;
        }

        /* 3cols */
        .l-3cols > div {
          flex: 1;
        }

        /* 3rows */
        .l-3rows {
          flex-direction: column;
        }
        .l-3rows > div {
          flex: 1;
        }

        /* grid2x2 */
        .l-grid2x2 {
          display: grid;
          grid-template-columns: 1fr 1fr;
          grid-template-rows: 1fr 1fr;
          gap: 1px;
        }

        /* Columns/Rows based layouts */
        .l-col {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 1px;
          background: transparent !important;
        }

        .l-col > div {
          flex: 1;
          width: 100%;
        }

        .l-row {
          flex: 1;
          display: flex;
          gap: 1px;
          background: transparent !important;
        }

        .l-row > div {
          flex: 1;
          height: 100%;
        }

        .l-topHeavy {
          flex-direction: column;
        }

        .l-bottomHeavy {
          flex-direction: column;
        }
      `}</style>
    </nav>
  );
});

Tabs.displayName = 'Tabs';

export default Tabs;
