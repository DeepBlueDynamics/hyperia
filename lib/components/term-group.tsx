import React from 'react';

import {connect} from 'react-redux';

import type {HyperState, HyperDispatch, TermGroupProps, TermGroupOwnProps} from '../../typings/hyper';
import {resizeTermGroup} from '../actions/term-groups';
import {decorate, getTermProps, getTermGroupProps} from '../utils/plugins';

import SplitPane_ from './split-pane';
import Term_ from './term';
import WebPane from './web-pane';

const Term = decorate(Term_, 'Term');
const SplitPane = decorate(SplitPane_, 'SplitPane');

class TermGroup_ extends React.PureComponent<TermGroupProps> {
  bound: WeakMap<(uid: string, ...args: any[]) => any, Record<string, (...args: any[]) => any>>;
  term?: Term_ | null;
  constructor(props: TermGroupProps, context: any) {
    super(props, context);
    this.bound = new WeakMap();
  }

  bind<T extends (uid: string, ...args: any[]) => any>(
    fn: T,
    thisObj: any,
    uid: string
  ): (...args: T extends (uid: string, ..._args: infer I) => any ? I : never) => ReturnType<T> {
    if (!this.bound.has(fn)) {
      this.bound.set(fn, {});
    }
    const map = this.bound.get(fn)!;
    if (!map[uid]) {
      map[uid] = fn.bind(thisObj, uid);
    }
    return map[uid];
  }

  renderSplit(groups: JSX.Element[]) {
    const [first, ...rest] = groups;
    if (rest.length === 0) {
      return first;
    }

    const direction = this.props.termGroup.direction!.toLowerCase() as 'horizontal' | 'vertical';
    return (
      <SplitPane
        direction={direction}
        sizes={this.props.termGroup.sizes}
        onResize={this.props.onTermGroupResize}
        borderColor={this.props.borderColor}
      >
        {groups}
      </SplitPane>
    );
  }

  onTermRef = (uid: string, term: Term_ | null) => {
    this.term = term;
    this.props.ref_(uid, term);
  };

  renderTerm(uid: string, splitLabel?: string) {
    const session = this.props.sessions[uid];
    if (!session) {
      return (
        <div
          className="term_fit term_wrapper"
          style={{position: 'relative', background: this.props.backgroundColor || '#0a0a12'}}
        />
      );
    }
    const termRef = this.props.terms[uid];
    const props = getTermProps(uid, this.props, {
      splitLabel: splitLabel || '',
      isTermActive: uid === this.props.activeSession,
      term: termRef ? termRef.term : null,
      fitAddon: termRef ? termRef.fitAddon : null,
      searchAddon: termRef ? termRef.searchAddon : null,
      scrollback: this.props.scrollback,
      backgroundColor: this.props.backgroundColor,
      foregroundColor: this.props.foregroundColor,
      colors: this.props.colors,
      cursorBlink: this.props.cursorBlink,
      cursorShape: this.props.cursorShape,
      cursorColor: this.props.cursorColor,
      cursorAccentColor: this.props.cursorAccentColor,
      fontSize: this.props.fontSize,
      fontFamily: this.props.fontFamily,
      uiFontFamily: this.props.uiFontFamily,
      fontSmoothing: this.props.fontSmoothing,
      fontWeight: this.props.fontWeight,
      fontWeightBold: this.props.fontWeightBold,
      lineHeight: this.props.lineHeight,
      letterSpacing: this.props.letterSpacing,
      modifierKeys: this.props.modifierKeys,
      padding: this.props.padding,
      cleared: session.cleared,
      search: session.search,
      cols: session.cols,
      rows: session.rows,
      copyOnSelect: this.props.copyOnSelect,
      bell: this.props.bell,
      bellSoundURL: this.props.bellSoundURL,
      bellSound: this.props.bellSound,
      onActive: this.bind(this.props.onActive, null, uid),
      onCwd: (this.props as any).onCwd ? this.bind((this.props as any).onCwd, null, uid) : undefined,
      onBell: this.bind(this.props.onBell, null, uid),
      onResize: this.bind(this.props.onResize, null, uid),
      onTitle: this.bind(this.props.onTitle, null, uid),
      onData: this.bind(this.props.onData, null, uid),
      onOpenSearch: this.bind(this.props.onOpenSearch, null, uid),
      onCloseSearch: this.bind(this.props.onCloseSearch, null, uid),
      onContextMenu: this.bind(this.props.onContextMenu, null, uid),
      borderColor: this.props.borderColor,
      selectionColor: this.props.selectionColor,
      quickEdit: this.props.quickEdit,
      webGLRenderer: this.props.webGLRenderer,
      webLinksActivationKey: this.props.webLinksActivationKey,
      macOptionSelectionMode: this.props.macOptionSelectionMode,
      disableLigatures: this.props.disableLigatures,
      screenReaderMode: this.props.screenReaderMode,
      windowsPty: this.props.windowsPty,
      imageSupport: this.props.imageSupport,
      uid,
      groupUid: this.props.termGroup.uid,
      defaultProfile: (this.props as any).defaultProfile,
      profiles: (this.props as any).profiles,
      env: (this.props as any).env,
      setWebPaneUrl: (this.props as any).setWebPaneUrl,
      onClosePane: (this.props as any).onClosePane,
      sessionProfile: session ? (session as any).profile : undefined,
      sessionTitle: session ? (session as any).title : undefined,
      sessionTabName: session ? (session as any).tabName : undefined,
      sessionManualTitle: session ? (session as any).manualTitle : false,
      sessionCwd: session ? (session as any).cwd : undefined,
      sessionShellName: session ? (session as any).shellName : undefined,
      allTermGroups: (this.props as any).parentProps.allTermGroups
    } as any);

    // This will create a new ref_ function for every render,
    // which is inefficient. Should maybe do something similar
    // to this.bind.
    return <Term ref_={this.onTermRef} key={uid} {...props} />;
  }

  // Count leaf (terminal or web) nodes in a group subtree
  countLeaves(group: any): number {
    if (group.sessionUid) return 1;
    if (group.webUrl !== undefined && group.webUrl !== null) return 1;
    const children = group.children || [];
    const {termGroups} = (this.props as any).parentProps || {};
    if (!termGroups) return (children.length || 1) as number;
    let count = 0;
    for (const cuid of children) {
      const child = termGroups[cuid];
      if (child) count += this.countLeaves(child);
      else count += 1;
    }
    return count;
  }

  render() {
    const {childGroups, termGroup} = this.props;
    const splitOffset = ((this.props as any).splitOffset as number) || 0;
    const isRoot = !(this.props as any).splitLabel && !splitOffset;

    if ((termGroup as any).webUrl !== undefined && (termGroup as any).webUrl !== null) {
      const label = (this.props as any).splitLabel as string | undefined || 'a';
      return (
        <WebPane
          url={(termGroup as any).webUrl}
          groupUid={termGroup.uid}
          hasSession={!!termGroup.sessionUid}
          sessionUid={termGroup.sessionUid}
          splitLabel={label}
          allTermGroups={(this.props as any).parentProps.allTermGroups}
        />
      );
    }

    if (termGroup.sessionUid) {
      const label = (this.props as any).splitLabel as string | undefined || 'a';
      return this.renderTerm(termGroup.sessionUid, label);
    }

    if (!childGroups || childGroups.length === 0) {
      return (
        <div
          className="term_fit term_wrapper"
          style={{position: 'relative', background: this.props.backgroundColor || '#0a0a12'}}
        />
      );
    }

    // Count total leaves to decide if we need labels at all
    const totalLeaves = this.countLeaves(termGroup);
    const needLabels = true;

    let offset = splitOffset;
    const groups = childGroups
      .asMutable()
      .map((child) => {
        if (!child) return null;
        const leafCount = this.countLeaves(child);
        const label = needLabels ? String.fromCharCode(97 + offset) : undefined;
        const props = getTermGroupProps(
          child.uid,
          this.props.parentProps,
          Object.assign({}, this.props, {
            termGroup: child,
            splitLabel: (child.sessionUid || (child as any).webUrl) ? label : undefined,
            splitOffset: offset
          })
        );
        offset += leafCount;

        return <DecoratedTermGroup key={child.uid} {...props} />;
      })
      .filter((g): g is JSX.Element => !!g);

    return this.renderSplit(groups);
  }
}

const mapStateToProps = (state: HyperState, ownProps: TermGroupOwnProps) => ({
  childGroups: ownProps.termGroup.children.map((uid) => state.termGroups.termGroups[uid]).filter(Boolean)
});

const mapDispatchToProps = (dispatch: HyperDispatch, ownProps: TermGroupOwnProps) => ({
  onTermGroupResize(splitSizes: number[]) {
    dispatch(resizeTermGroup(ownProps.termGroup.uid, splitSizes));
  }
});

const TermGroup = connect(mapStateToProps, mapDispatchToProps, null, {
  forwardRef: true
})(TermGroup_);

const DecoratedTermGroup = decorate(TermGroup, 'TermGroup');

export default TermGroup;

export type TermGroupConnectedProps = ReturnType<typeof mapStateToProps> & ReturnType<typeof mapDispatchToProps>;
