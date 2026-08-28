import React, {forwardRef, useRef} from 'react';

import type {HeaderProps} from '../../typings/hyper';
import {decorate, getTabsProps} from '../utils/plugins';

import Tabs_ from './tabs';

const Tabs = decorate(Tabs_, 'Tabs');

const Header = forwardRef<HTMLElement, HeaderProps>((props, ref) => {
  // Where the window sat when the current press started, used below to swallow a
  // tab switch that was really a titlebar drag. Refs recorded on the *capture*
  // phase, not state set on bubble: a tab now selects on mousedown (tab.tsx), so
  // the selection runs inside the very same mousedown that records this. State
  // would still hold the previous press's coordinates at that point — on the
  // first press after launch that is (0, 0), which never matches a real window
  // position, and every tab switch would be swallowed.
  const headerMouseDownWindowX = useRef(0);
  const headerMouseDownWindowY = useRef(0);

  const onChangeIntent = (active: string) => {
    if (window.screenX !== headerMouseDownWindowX.current || window.screenY !== headerMouseDownWindowY.current) {
      return;
    }
    props.onChangeTab(active);
  };

  const handleHeaderMouseDown = () => {
    headerMouseDownWindowX.current = window.screenX;
    headerMouseDownWindowY.current = window.screenY;
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

  const handleMinimizeClick = () => {
    props.minimize();
  };

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
  const maxButtonHref = props.maximized
    ? './renderer/assets/icons.svg#restore-window'
    : './renderer/assets/icons.svg#maximize-window';

  return (
    <header
      className={`header_header ${isMac && 'header_headerRounded'}`}
      onMouseDownCapture={handleHeaderMouseDown}
      onMouseUp={() => window.focusActiveTerm()}
      onDoubleClick={handleMaximizeClick}
      ref={ref}
    >
      {/* Single row: tabs + new tab */}
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
            openNewTab: props.openNewTab,
            onMoveTab: props.onMoveTab
          })}
        />
        {/* Linux is frameless (app/ui/window.ts) and gets NEITHER the native
            Windows titleBarOverlay NOR macOS traffic lights — so without these
            in-app buttons it has no min/max/close at all. Gated to Linux ONLY so
            Windows' native overlay and macOS's traffic lights are untouched. */}
        {process.platform === 'linux' && (
          <div className="header_windowControls">
            <div className="header_winBtn" onClick={handleMinimizeClick} title="Minimize">
              <svg className="header_shape">
                <use xlinkHref="./renderer/assets/icons.svg#minimize-window" />
              </svg>
            </div>
            <div
              className="header_winBtn"
              onClick={handleMaximizeClick}
              title={props.maximized ? 'Restore' : 'Maximize'}
            >
              <svg className="header_shape">
                <use xlinkHref={maxButtonHref} />
              </svg>
            </div>
            <div className="header_winBtn header_closeWindow" onClick={handleCloseClick} title="Close">
              <svg className="header_shape">
                <use xlinkHref="./renderer/assets/icons.svg#close-window" />
              </svg>
            </div>
          </div>
        )}
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
          background: var(--bg-secondary);
          border-bottom: 0.5px solid var(--border-neutral);
          box-sizing: border-box;
        }

        .header_shape,
        .header_shape > svg {
          width: 40px;
          height: 34px;
          padding: 12px 15px;
          -webkit-app-region: no-drag;
          color: var(--text-secondary);
          opacity: 0.7;
          shape-rendering: crispEdges;
        }

        .header_shape:hover {
          color: var(--text-primary);
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
          width: 34px;
          height: 34px;
          -webkit-app-region: no-drag;
        }

        /* The shared .header_shape sizing (40px + 12/15 padding, content-box)
           left a ~10px glyph adrift in an oversized cell — the three controls
           read as scattered. Scope a tight box for the window buttons only:
           34px cells flush together, ~12px glyphs. (Hamburger untouched.) */
        .header_winBtn .header_shape,
        .header_winBtn .header_shape > svg {
          width: 34px;
          height: 34px;
          padding: 11px;
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
