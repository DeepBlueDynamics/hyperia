import {clipboard} from 'electron';
import React, {forwardRef, useEffect, useRef} from 'react';

import Mousetrap from 'mousetrap';
import type {MousetrapInstance} from 'mousetrap';
import stylis from 'stylis';

import type {HyperState, HyperProps, HyperDispatch} from '../../typings/hyper';
import * as uiActions from '../actions/ui';
import {getRegisteredKeys, getCommandHandler, shouldPreventDefault} from '../command-registry';
import type Terms from '../components/terms';
import {connect} from '../utils/plugins';

import {HeaderContainer} from './header';
import NotificationsContainer from './notifications';
import TermsContainer from './terms';

const isMac = /Mac/.test(navigator.userAgent);

const getThemeCSS = (styleTheme: any) => {
  if (!styleTheme) return '';
  let css = '';
  if (styleTheme.root) {
    css += `
      :root {
        ${Object.entries(styleTheme.root)
          .map(([key, val]) => `--${key}: ${val};`)
          .join('\n')}
      }
    `;
  }
  if (styleTheme.dark) {
    css += `
      @media (prefers-color-scheme: dark) {
        :root {
          ${Object.entries(styleTheme.dark)
            .map(([key, val]) => `--${key}: ${val};`)
            .join('\n')}
        }
      }
    `;
  }
  if (styleTheme.light) {
    css += `
      @media (prefers-color-scheme: light) {
        :root {
          ${Object.entries(styleTheme.light)
            .map(([key, val]) => `--${key}: ${val};`)
            .join('\n')}
        }
      }
    `;
  }
  return css;
};

const Hyper = forwardRef<HTMLDivElement, HyperProps>((props, ref) => {
  const mousetrap = useRef<MousetrapInstance | null>(null);
  const terms = useRef<Terms | null>(null);

  useEffect(() => {
    void attachKeyListeners();
  }, [props.lastConfigUpdate]);
  useEffect(() => {
    handleFocusActive(props.activeSession);
  }, [props.activeSession]);

  const handleFocusActive = (uid?: string | null) => {
    const term = uid && terms.current?.getTermByUid(uid);
    if (term) {
      term.focus();
    }
  };

  const handleSelectAll = () => {
    const term = terms.current?.getActiveTerm();
    if (term) {
      term.selectAll();
    }
  };

  const attachKeyListeners = async () => {
    if (!mousetrap.current) {
      mousetrap.current = new (Mousetrap as any)(window, true);
      mousetrap.current!.stopCallback = () => {
        // All events should be intercepted even if focus is in an input/textarea
        return false;
      };
    } else {
      mousetrap.current.reset();
    }

    const keys = await getRegisteredKeys();
    Object.keys(keys).forEach((commandKeys) => {
      mousetrap.current?.bind(
        commandKeys,
        (e) => {
          const command = keys[commandKeys];
          const activeTerm = terms.current?.getActiveTerm();
          if (command === 'editor:break' && activeTerm && activeTerm.term.hasSelection()) {
            clipboard.writeText(activeTerm.term.getSelection());
            activeTerm.term.clearSelection();
            (e as any).catched = true;
            e.preventDefault();
            return;
          }
          // We should tell xterm to ignore this event.
          (e as any).catched = true;
          props.execCommand(command, getCommandHandler(command), e);
          shouldPreventDefault(command) && e.preventDefault();
        },
        'keydown'
      );
    });
  };

  useEffect(() => {
    void attachKeyListeners();
    window.rpc.on('term selectAll', handleSelectAll);
  }, []);

  const onTermsRef = (_terms: Terms | null) => {
    terms.current = _terms;
    window.focusActiveTerm = (uid?: string) => {
      if (uid) {
        handleFocusActive(uid);
      } else {
        terms.current?.getActiveTerm()?.focus();
      }
    };
  };

  useEffect(() => {
    return () => {
      mousetrap.current?.reset();
    };
  }, []);

  const {isMac: isMac_, customCSS, uiFontFamily, borderColor, maximized, fullScreen, styleTheme} = props;
  const borderWidth = isMac_ ? '' : `${maximized ? '0' : '1'}px`;
  stylis.set({prefix: false});
  return (
    <div id="hyper" ref={ref}>
      <div
        style={{fontFamily: uiFontFamily, borderColor, borderWidth}}
        className={`hyper_main ${isMac_ && 'hyper_mainRounded'} ${fullScreen ? 'fullScreen' : ''}`}
      >
        <HeaderContainer />
        <TermsContainer ref_={onTermsRef} />
        {/* Status bar removed — agent status shown per-tab via dot indicators */}
        {props.customInnerChildren}
      </div>

      <NotificationsContainer />

      {props.customChildren}

      <style jsx global>{`
        :root {
          --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          --weight-regular: 400;
          --weight-medium: 500;

          /* Spacing Scale */
          --space-2: 2px;
          --space-4: 4px;
          --space-6: 6px;
          --space-8: 8px;
          --space-10: 10px;
          --space-12: 12px;
          --space-14: 14px;
          --space-16: 16px;
          --space-20: 20px;

          /* Radius Scale */
          --radius-3: 3px;
          --radius-4: 4px;
          --radius-6: 6px;
          --radius-8: 8px;

          /* Band Heights */
          --band-height: 42px;
          --band-height-compact: 34px;
        }

        @media (prefers-color-scheme: dark) {
          :root {
            --bg-primary: #0a0a0c;
            --bg-secondary: #121216;
            --bg-tertiary: #18181c;
            --text-primary: #f4f4f7;
            --text-secondary: #90909b;
            --text-tertiary: #5c5c64;
            --border-neutral: rgba(255, 255, 255, 0.12);
            --border-focus: rgba(0, 150, 255, 0.5);
            --success-bg: rgba(16, 185, 129, 0.1);
            --success-text: #34d399;
            --info-bg: rgba(59, 130, 246, 0.1);
            --info-text: #60a5fa;
            --warning-bg: rgba(245, 158, 11, 0.1);
            --warning-text: #fbbf24;
            --danger-bg: rgba(239, 68, 68, 0.1);
            --danger-text: #f87171;
            --color-background-ai: #3c3489;
            --color-text-ai: #eeedfe;
            --color-ai-purple: #7f77dd;

            /* Semantic themed tints */
            --bg-success: rgba(16, 185, 129, 0.1);
            --text-success: #34d399;
            --bg-info: rgba(59, 130, 246, 0.1);
            --text-info: #60a5fa;
            --bg-warning: rgba(245, 158, 11, 0.1);
            --text-warning: #fbbf24;
            --bg-danger: rgba(239, 68, 68, 0.1);
            --text-danger: #f87171;
            --bg-ai: #3c3489;
            --text-ai: #eeedfe;
          }
        }

        @media (prefers-color-scheme: light) {
          :root {
            --bg-primary: #ffffff;
            --bg-secondary: #f4f4f5;
            --bg-tertiary: #e4e4e7;
            --text-primary: #09090b;
            --text-secondary: #71717a;
            --text-tertiary: #a1a1aa;
            --border-neutral: rgba(9, 9, 11, 0.12);
            --border-focus: rgba(0, 120, 255, 0.5);
            --success-bg: rgba(209, 250, 229, 0.5);
            --success-text: #065f46;
            --info-bg: rgba(219, 234, 254, 0.5);
            --info-text: #1e40af;
            --warning-bg: rgba(254, 243, 199, 0.5);
            --warning-text: #92400e;
            --danger-bg: rgba(254, 226, 226, 0.5);
            --danger-text: #991b1b;
            --color-background-ai: #eeedfe;
            --color-text-ai: #3c3489;
            --color-ai-purple: #7f77dd;

            /* Semantic themed tints */
            --bg-success: rgba(209, 250, 229, 0.5);
            --text-success: #065f46;
            --bg-info: rgba(219, 234, 254, 0.5);
            --text-info: #1e40af;
            --bg-warning: rgba(254, 243, 199, 0.5);
            --text-warning: #92400e;
            --bg-danger: rgba(254, 226, 226, 0.5);
            --text-danger: #991b1b;
            --bg-ai: #eeedfe;
            --text-ai: #3c3489;
          }
        }

        body {
          margin: 0;
          background-color: var(--bg-tertiary) !important;
          color: var(--text-primary) !important;
          font-family: var(--font-sans);
          font-size: 11px;
        }
      `}</style>

      <style jsx>
        {`
          .hyper_main {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            border: 0.5px solid var(--border-neutral);
            background: var(--bg-tertiary);
          }

          .hyper_mainRounded {
          }
        `}
      </style>

      {/*
        Add custom CSS to Hyper.
        We add a scope to the customCSS so that it can get around the weighting applied by styled-jsx
      */}
      <style dangerouslySetInnerHTML={{__html: stylis('#hyper', customCSS)}} />
      <style dangerouslySetInnerHTML={{__html: getThemeCSS(styleTheme)}} />
    </div>
  );
});

Hyper.displayName = 'Hyper';

const mapStateToProps = (state: HyperState) => {
  const activeUid = state.sessions.activeUid;
  return {
    isMac,
    customCSS: state.ui.css,
    uiFontFamily: state.ui.uiFontFamily,
    borderColor: state.ui.borderColor,
    activeSession: activeUid,
    backgroundColor: state.ui.backgroundColor,
    maximized: state.ui.maximized,
    fullScreen: state.ui.fullScreen,
    lastConfigUpdate: state.ui._lastUpdate,
    activeAgentStatus: activeUid ? state.ui.agentStatuses[activeUid] : undefined,
    styleTheme: state.ui.styleTheme
  };
};

const mapDispatchToProps = (dispatch: HyperDispatch) => {
  return {
    execCommand: (command: string, fn: (e: any, dispatch: HyperDispatch) => void, e: any) => {
      dispatch(uiActions.execCommand(command, fn, e));
    }
  };
};

const HyperContainer = connect(mapStateToProps, mapDispatchToProps, null, {forwardRef: true})(Hyper, 'Hyper');

export default HyperContainer;

export type HyperConnectedProps = ReturnType<typeof mapStateToProps> & ReturnType<typeof mapDispatchToProps>;
