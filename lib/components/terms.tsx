import React from 'react';

import type {TermsProps, HyperDispatch} from '../../typings/hyper';
import {registerCommandHandlers} from '../command-registry';
import {ObjectTypedKeys} from '../utils/object';
import {decorate, getTermGroupProps} from '../utils/plugins';

import StyleSheet_ from './style-sheet';
import type Term from './term';
import TermGroup_ from './term-group';

const TermGroup = decorate(TermGroup_, 'TermGroup');
const StyleSheet = decorate(StyleSheet_, 'StyleSheet');

export default class Terms extends React.Component<React.PropsWithChildren<TermsProps>> {
  terms: Record<string, Term>;
  registerCommands: (cmds: Record<string, (e: any, dispatch: HyperDispatch) => void>) => void;
  constructor(props: TermsProps, context: any) {
    super(props, context);
    this.terms = {};
    this.registerCommands = registerCommandHandlers;
    props.ref_(this);
  }

  shouldComponentUpdate(nextProps: TermsProps & {children: any}) {
    return (
      ObjectTypedKeys(nextProps).some((i) => i !== 'write' && this.props[i] !== nextProps[i]) ||
      ObjectTypedKeys(this.props).some((i) => i !== 'write' && this.props[i] !== nextProps[i])
    );
  }

  onRef = (uid: string, term: Term | null) => {
    if (term) {
      this.terms[uid] = term;
    } else {
      if (!this.props.sessions[uid]) {
        delete this.terms[uid];
      }
    }
  };

  getTermByUid(uid: string) {
    return this.terms[uid];
  }

  getActiveTerm() {
    return this.getTermByUid(this.props.activeSession!);
  }

  onTerminal(uid: string, term: Term) {
    this.terms[uid] = term;
  }

  componentDidMount() {
    window.addEventListener('contextmenu', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;

      // Do NOT trigger the default terminal context menu for UI elements, labels, and web panes.
      // Prevent default to ensure no context menu shows up at all in these areas.
      if (
        target.closest('.term_splitLabel') ||
        target.closest('.term_profileMenu') ||
        target.closest('.toolbar_wrap') ||
        target.closest('.toolbar_bar') ||
        target.closest('.header_header') ||
        target.closest('.header_bar') ||
        target.closest('.tabs_nav') ||
        target.closest('.web-pane') ||
        target.closest('webview')
      ) {
        e.preventDefault();
        return;
      }

      if (e.defaultPrevented) return;

      // Find the specific terminal component that was clicked
      let clickedTerm: Term | null = null;
      let clickedUid: string | null = null;
      for (const key in this.terms) {
        const term = this.terms[key];
        const outerRef = (term as any)?.termOuterRef?.current;
        const wrapperRef = term?.termWrapperRef;
        if (
          term &&
          ((outerRef && (outerRef.contains(target) || outerRef === target)) ||
           (wrapperRef && (wrapperRef.contains(target) || wrapperRef === target)))
        ) {
          clickedTerm = term;
          clickedUid = key;
          break;
        }
      }

      // If the right-click was not inside any terminal pane, ignore it
      if (!clickedTerm) {
        return;
      }

      const selection = clickedTerm.term.getSelection();
      const uid = clickedUid || this.props.activeSession!;
      this.props.onContextMenu(uid, selection);
    });
  }

  componentDidUpdate(prevProps: TermsProps) {
    for (const uid in prevProps.sessions) {
      if (!this.props.sessions[uid]) {
        try {
          this.terms[uid]?.term?.dispose();
        } catch (e) {
          console.warn('[terms] Error disposing term:', uid, e);
        }
        delete this.terms[uid];
      }
    }
  }

  componentWillUnmount() {
    this.props.ref_(null);
  }

  render() {
    return (
      <div className="terms_terms terms_termsNotShifted">
        {this.props.customChildrenBefore}
        {this.props.termGroups.map((termGroup) => {
          const {uid} = termGroup;
          const isActive = uid === this.props.activeRootGroup;
          const props = getTermGroupProps(uid, this.props, {
            termGroup,
            terms: this.terms,
            activeSession: this.props.activeSession,
            sessions: this.props.sessions,
            scrollback: this.props.scrollback,
            backgroundColor: this.props.backgroundColor,
            foregroundColor: this.props.foregroundColor,
            borderColor: this.props.borderColor,
            selectionColor: this.props.selectionColor,
            colors: this.props.colors,
            cursorShape: this.props.cursorShape,
            cursorBlink: this.props.cursorBlink,
            cursorColor: this.props.cursorColor,
            cursorAccentColor: this.props.cursorAccentColor,
            fontSize: this.props.fontSize,
            fontFamily: this.props.fontFamily,
            uiFontFamily: this.props.uiFontFamily,
            fontWeight: this.props.fontWeight,
            fontWeightBold: this.props.fontWeightBold,
            lineHeight: this.props.lineHeight,
            letterSpacing: this.props.letterSpacing,
            padding: this.props.padding,
            bell: this.props.bell,
            bellSoundURL: this.props.bellSoundURL,
            bellSound: this.props.bellSound,
            copyOnSelect: this.props.copyOnSelect,
            modifierKeys: this.props.modifierKeys,
            onActive: this.props.onActive,
            onCwd: (this.props as any).onCwd,
            onBell: this.props.onBell,
            onResize: this.props.onResize,
            onTitle: this.props.onTitle,
            onData: this.props.onData,
            onOpenSearch: this.props.onOpenSearch,
            onCloseSearch: this.props.onCloseSearch,
            onContextMenu: this.props.onContextMenu,
            quickEdit: this.props.quickEdit,
            webGLRenderer: this.props.webGLRenderer,
            webLinksActivationKey: this.props.webLinksActivationKey,
            macOptionSelectionMode: this.props.macOptionSelectionMode,
            disableLigatures: this.props.disableLigatures,
            screenReaderMode: this.props.screenReaderMode,
            windowsPty: this.props.windowsPty,
            imageSupport: this.props.imageSupport,
            defaultProfile: (this.props as any).defaultProfile,
            profiles: (this.props as any).profiles,
            env: (this.props as any).env,
            setWebPaneUrl: (this.props as any).setWebPaneUrl,
            onClosePane: (this.props as any).onClosePane,
            onPopOutPane: (this.props as any).onPopOutPane,
            parentProps: this.props
          });

          return (
            <div key={`d${uid}`} className={`terms_termGroup ${isActive ? 'terms_termGroupActive' : ''}`}>
              <TermGroup key={uid} ref_={this.onRef} {...props} />
            </div>
          );
        })}
        {this.props.customChildren}
        <StyleSheet
          backgroundColor={this.props.backgroundColor}
          customCSS={this.props.customCSS}
          fontFamily={this.props.fontFamily}
          foregroundColor={this.props.foregroundColor}
          borderColor={this.props.borderColor}
        />

        <style jsx>{`
          .terms_terms {
            position: absolute;
            margin-top: 34px;
            top: 0;
            right: 0;
            left: 0;
            bottom: 0;
            color: var(--text-primary);
            background: var(--bg-tertiary);
            padding: 8px;
            box-sizing: border-box;
          }

          .terms_termsShifted {
            margin-top: 68px;
            animation: shift-down 0.2s ease-out;
          }

          .terms_termsNotShifted {
            margin-top: 34px;
            animation: shift-up 0.3s ease;
          }

          @keyframes shift-down {
            0% {
              transform: translateY(-34px);
            }
            100% {
              transform: translateY(0px);
            }
          }

          @keyframes shift-up {
            0% {
              transform: translateY(34px);
            }
            100% {
              transform: translateY(0px);
            }
          }

          .terms_termGroup {
            display: block;
            width: 100%;
            height: 100%;
            position: absolute;
            top: 0;
            left: -9999em; /* Offscreen to pause xterm rendering, thanks to IntersectionObserver */
          }

          .terms_termGroupActive {
            left: 0;
          }
        `}</style>
      </div>
    );
  }
}
