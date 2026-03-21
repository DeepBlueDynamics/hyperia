import React, {forwardRef, useEffect, useRef, useCallback} from 'react';

import type {TabsProps} from '../../typings/hyper';
import {decorate, getTabProps} from '../utils/plugins';

import DropdownButton from './new-tab';
import Tab_ from './tab';

const Tab = decorate(Tab_, 'Tab');
const isMac = /Mac/.test(navigator.userAgent);

const Tabs = forwardRef<HTMLElement, TabsProps>((props, ref) => {
  const {tabs = [], borderColor, onChange, onClose, fullScreen} = props;
  const listRef = useRef<HTMLUListElement>(null);

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
          const {uid, title, isActive, hasActivity, agentStatus} = tab;
          const tabProps = getTabProps(tab, props, {
            text: title === '' ? 'Shell' : title,
            isFirst: i === 0,
            isLast: tabs.length - 1 === i,
            borderColor,
            isActive,
            hasActivity,
            agentStatus,
            onSelect: onChange.bind(null, uid),
            onClose: onClose.bind(null, uid)
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
      <DropdownButton {...props} tabsVisible={true} />
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
          flex-shrink: 1;
          min-width: 0;
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
          margin-left: ${isMac ? '76px' : '0'};
          flex-shrink: 1;
          min-width: 0;
          overflow-x: auto;
          overflow-y: hidden;
          scrollbar-width: none;
        }

        .tabs_list::-webkit-scrollbar {
          display: none;
        }

        .tabs_fullScreen {
          margin-left: -1px;
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
