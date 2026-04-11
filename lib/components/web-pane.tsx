import React from 'react';

import {connect} from 'react-redux';

import type {HyperDispatch} from '../../typings/hyper';
import {clearWebPane} from '../actions/term-groups';

// Match a real Chrome UA so sites don't block the request
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface WebPaneProps {
  url: string;
  groupUid: string;
  hasSession?: boolean; // true = overlaying a terminal; show × to restore it
  onClose?: () => void;
}

interface WebPaneState {
  error: string | null;
  loading: boolean;
}

class WebPane_ extends React.PureComponent<WebPaneProps, WebPaneState> {
  webviewRef = React.createRef<any>();

  constructor(props: WebPaneProps) {
    super(props);
    this.state = {error: null, loading: true};
  }

  componentDidMount() {
    const wv = this.webviewRef.current;
    if (!wv) return;

    wv.addEventListener('did-start-loading', () => {
      this.setState({loading: true, error: null});
    });

    wv.addEventListener('did-stop-loading', () => {
      this.setState({loading: false});
    });

    wv.addEventListener('did-fail-load', (e: any) => {
      // Error code -3 is ABORTED (e.g. redirect), ignore it
      if (e.errorCode === -3) return;
      this.setState({loading: false, error: e.errorDescription || 'Failed to load'});
    });
  }

  render() {
    const {url, onClose, hasSession} = this.props;
    const {error, loading} = this.state;

    return (
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: '#0e0e16'
        }}
      >
        {/* Address bar */}
        <div
          style={
            {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px',
              background: '#13131f',
              borderBottom: '1px solid #1a1a2e',
              flexShrink: 0,
              height: 28,
              WebkitAppRegion: 'no-drag'
            } as React.CSSProperties
          }
        >
          {loading && (
            <span style={{fontSize: 10, color: '#4af', flexShrink: 0, animation: 'spin 1s linear infinite'}}>⟳</span>
          )}
          {!loading && <span style={{fontSize: 11, color: '#556', flexShrink: 0}}>🌐</span>}
          <span
            style={{
              flex: 1,
              fontSize: 11,
              color: '#778',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: 'inherit'
            }}
            title={url}
          >
            {url}
          </span>
          {hasSession && (
            <span
              onClick={onClose}
              title="Close web pane"
              style={{fontSize: 14, color: '#556', cursor: 'pointer', flexShrink: 0, lineHeight: 1, padding: '0 2px'}}
              onMouseEnter={(e) => ((e.target as HTMLElement).style.color = '#e08080')}
              onMouseLeave={(e) => ((e.target as HTMLElement).style.color = '#556')}
            >
              ×
            </span>
          )}
        </div>

        {/* Error state */}
        {error && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#0e0e16',
              gap: 12
            }}
          >
            <span style={{fontSize: 48}}>🦕</span>
            <span style={{fontSize: 14, color: '#778'}}>This page could not be loaded</span>
            <span style={{fontSize: 11, color: '#445', maxWidth: 300, textAlign: 'center'}}>{error}</span>
            <span style={{fontSize: 11, color: '#446'}}>{url}</span>
          </div>
        )}

        {/* Webview — always mounted so it can navigate */}
        {/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */}
        {/* @ts-ignore — webview is a valid Electron tag but not in React types */}
        <webview
          ref={this.webviewRef}
          src={url}
          useragent={BROWSER_UA}
          style={{flex: 1, display: error ? 'none' : 'flex'}}
        />
      </div>
    );
  }
}

const mapDispatchToProps = (dispatch: HyperDispatch, ownProps: WebPaneProps) => ({
  onClose() {
    dispatch(clearWebPane(ownProps.groupUid) as any);
  }
});

export default connect(null, mapDispatchToProps)(WebPane_);
