import React, {forwardRef, useState} from 'react';

import type {HeaderProps} from '../../typings/hyper';
import {decorate, getTabsProps} from '../utils/plugins';

import Tabs_ from './tabs';

const Tabs = decorate(Tabs_, 'Tabs');

const Header = forwardRef<HTMLElement, HeaderProps>((props, ref) => {
  const [headerMouseDownWindowX, setHeaderMouseDownWindowX] = useState<number>(0);
  const [headerMouseDownWindowY, setHeaderMouseDownWindowY] = useState<number>(0);

  const onChangeIntent = (active: string) => {
    if (window.screenX !== headerMouseDownWindowX || window.screenY !== headerMouseDownWindowY) {
      return;
    }
    props.onChangeTab(active);
  };

  const handleHeaderMouseDown = () => {
    setHeaderMouseDownWindowX(window.screenX);
    setHeaderMouseDownWindowY(window.screenY);
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleHamburgerMenuClick = (event: React.MouseEvent) => {
    let {right: x, bottom: y} = event.currentTarget.getBoundingClientRect();
    x -= 15;
    y -= 12;
    props.openHamburgerMenu({x, y});
  };

  const handleMaximizeClick = () => {
    if (props.maximized) {
      props.unmaximize();
    } else {
      props.maximize();
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleMinimizeClick = () => {
    props.minimize();
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleCloseClick = () => {
    props.close();
  };

  const getWindowHeaderConfig = () => {
    const {showHamburgerMenu, showWindowControls} = props;
    const defaults = {
      hambMenu: !props.isMac,
      winCtrls: !props.isMac
    };
    if (props.isMac) {
      return defaults;
    }
    return {
      hambMenu: showHamburgerMenu === '' ? defaults.hambMenu : showHamburgerMenu,
      winCtrls: showWindowControls === '' ? defaults.winCtrls : showWindowControls
    };
  };

  const {isMac} = props;
  const {borderColor} = props;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {hambMenu, winCtrls} = getWindowHeaderConfig();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const maxButtonHref = props.maximized
    ? './renderer/assets/icons.svg#restore-window'
    : './renderer/assets/icons.svg#maximize-window';

  return (
    <header
      className={`header_header ${isMac && 'header_headerRounded'}`}
      onMouseDown={handleHeaderMouseDown}
      onMouseUp={() => window.focusActiveTerm()}
      onDoubleClick={handleMaximizeClick}
      ref={ref}
    >
      {/* Single row: hamburger | tabs + new tab | drag region | window controls */}
      <div className="header_bar" style={{borderColor}}>
        <Tabs
          {...getTabsProps(props, {
            tabs: props.tabs,
            borderColor: props.borderColor,
            backgroundColor: props.backgroundColor,
            onClose: props.onCloseTab,
            onChange: onChangeIntent,
            onDescribe: props.onDescribe,
            fullScreen: props.fullScreen,
            defaultProfile: props.defaultProfile,
            profiles: props.profiles.asMutable({deep: true}),
            openNewTab: props.openNewTab
          })}
        />

        {/* Drag region fills remaining space */}
        <div className="header_dragRegion" />
      </div>

      {props.customChildrenBefore}
      {props.customChildren}

      <style jsx>{`
        .header_header {
          position: fixed;
          top: 1px;
          left: 1px;
          right: 1px;
          z-index: 100;
        }

        .header_headerRounded {
          border-top-left-radius: 4px;
          border-top-right-radius: 4px;
        }

        .header_bar {
          height: 34px;
          display: flex;
          align-items: stretch;
          background: #1a1a1a;
          border-bottom: 1px solid #333;
        }

        .header_dragRegion {
          flex: 1;
          -webkit-app-region: drag;
          min-width: 40px;
        }

        .header_shape,
        .header_shape > svg {
          width: 40px;
          height: 34px;
          padding: 12px 15px;
          -webkit-app-region: no-drag;
          color: #fff;
          opacity: 0.5;
          shape-rendering: crispEdges;
        }

        .header_shape:hover {
          opacity: 1;
        }

        .header_shape:active {
          opacity: 0.3;
        }

        .header_hamburger {
          flex-shrink: 0;
        }

        .header_windowControls {
          display: flex;
          flex-shrink: 0;
        }

        .header_winBtn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 46px;
          height: 34px;
          -webkit-app-region: no-drag;
        }

        .header_closeWindow:hover {
          background: #e81123;
        }

        .header_closeWindow:hover .header_shape {
          opacity: 1;
        }
      `}</style>
    </header>
  );
});

Header.displayName = 'Header';

export default Header;
