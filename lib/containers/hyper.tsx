import React, {forwardRef, useEffect, useRef} from 'react';
import {clipboard} from 'electron';

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
import {ToolbarContainer} from './toolbar';

const isMac = /Mac/.test(navigator.userAgent);

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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
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

  const {isMac: isMac_, customCSS, uiFontFamily, borderColor, maximized, fullScreen} = props;
  const borderWidth = isMac_ ? '' : `${maximized ? '0' : '1'}px`;
  stylis.set({prefix: false});
  return (
    <div id="hyper" ref={ref}>
      <div
        style={{fontFamily: uiFontFamily, borderColor, borderWidth}}
        className={`hyper_main ${isMac_ && 'hyper_mainRounded'} ${fullScreen ? 'fullScreen' : ''}`}
      >
        <HeaderContainer />
        <ToolbarContainer />
        <TermsContainer ref_={onTermsRef} />
        {/* Status bar removed — agent status shown per-tab via dot indicators */}
        {props.customInnerChildren}
      </div>

      <NotificationsContainer />

      {props.customChildren}

      <style jsx>
        {`
          .hyper_main {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            border: 1px solid #333;
          }

          .hyper_mainRounded {
            border-radius: 10.5px;
            overflow: hidden;
          }
        `}
      </style>

      {/*
        Add custom CSS to Hyper.
        We add a scope to the customCSS so that it can get around the weighting applied by styled-jsx
      */}
      <style dangerouslySetInnerHTML={{__html: stylis('#hyper', customCSS)}} />
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
    activeAgentStatus: activeUid ? state.ui.agentStatuses[activeUid] : undefined
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
