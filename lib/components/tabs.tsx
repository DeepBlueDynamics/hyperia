import React, {forwardRef, useEffect, useRef, useCallback} from 'react';

import type {TabsProps} from '../../typings/hyper';
import {decorate, getTabProps} from '../utils/plugins';

import Tab_ from './tab';

const Tab = decorate(Tab_, 'Tab');
const isMac = /Mac/.test(navigator.userAgent);
const isWindows = /Windows/.test(navigator.userAgent);
const trailingDragWidth = isMac ? 0 : isWindows ? 140 : 40;

const Tabs = forwardRef<HTMLElement, TabsProps>((props, ref) => {
  const {tabs = [], borderColor, onChange, onClose, onDescribe, fullScreen} = props;
  const onMoveTab = (props as any).onMoveTab as ((fromUid: string, toIndex: number) => void) | undefined;
  const listRef = useRef<HTMLUListElement>(null);
  const dragUidRef = useRef<string | null>(null);

  // Scroll active tab into view
  useEffect(() => {
    if (listRef.current) {
      const active = listRef.current.querySelector('.tab_active');
      if (active) {
        active.scrollIntoView({block: 'nearest', inline: 'nearest'});
      }
    }
  }, [tabs.find((t) => t.isActive)?.uid]);

  // Horizontal scroll with mouse wheel
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (listRef.current) {
      listRef.current.scrollLeft += e.deltaY;
    }
  }, []);

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
      {tabs.length === 1 && isMac ? <div className="tabs_title">{tabs[0].title}</div> : null}
      <ul
        key="list"
        ref={listRef}
        onWheel={handleWheel}
        className={`tabs_list ${fullScreen && isMac ? 'tabs_fullScreen' : ''}`}
      >
        {tabs.map((tab, i) => {
          const {uid, title, isActive, hasActivity, hasBell, agentStatus, tabName, description} = tab;
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
          font-size: 12px;
          height: 34px;
          line-height: 34px;
          vertical-align: middle;
          color: #9b9b9b;
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

        .tabs_title {
          text-align: center;
          color: #fff;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding-left: 76px;
          padding-right: 76px;
          flex-grow: 1;
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

        .tabs_borderShim {
          position: absolute;
          width: 76px;
          bottom: 0;
          border-color: #ccc;
          border-bottom-style: solid;
          border-bottom-width: 1px;
        }

        .tabs_borderShimUndo {
          border-bottom-width: 0px;
        }
      `}</style>
    </nav>
  );
});

Tabs.displayName = 'Tabs';

export default Tabs;
