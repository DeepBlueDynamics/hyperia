import React from 'react';

import {connect} from 'react-redux';

import type {HyperDispatch} from '../../typings/hyper';
import {clearWebPane} from '../actions/term-groups';
import rpc from '../rpc';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {ipcMain} = require('electron');

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
    if (!this.webviewRef.current) return;
    const wv = this.webviewRef.current;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    wv.addEventListener('did-start-loading', () => {
      this.setState({loading: true, error: null});
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    wv.addEventListener('did-stop-loading', () => {
      this.setState({loading: false});
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    wv.addEventListener('did-fail-load', (e: {errorCode: number; errorDescription: string}) => {
      if (e.errorCode === -3) return;
      this.setState({loading: false, error: e.errorDescription || 'Failed to load'});
    });

    // Listen for reload requests from the tab right-click menu
    this._reloadHandler = (uid: string) => {
      if (uid === this.props.groupUid && this.webviewRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        this.webviewRef.current.reload();
      }
    };
    rpc.on('web-pane-reload', this._reloadHandler);
  }

  componentWillUnmount() {
    if (this._reloadHandler) {
      rpc.removeListener('web-pane-reload', this._reloadHandler);
    }
  }

  _reloadHandler: ((uid: string) => void) | null = null;

  handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call */
    const remote = require('@electron/remote');
    const {Menu, MenuItem} = remote;
    const menu = new Menu();
    menu.append(
      new MenuItem({
        label: 'Reload',
        click: () => {
          if (this.webviewRef.current) this.webviewRef.current.reload();
        }
      })
    );
    menu.append(new MenuItem({type: 'separator'}));
    menu.append(new MenuItem({label: 'New Note', click: () => void ipcMain.emit('new-sticky', {})}));
    menu.append(new MenuItem({label: 'Ask Hyperia', click: () => void ipcMain.emit('open-ghost')}));
    menu.append(new MenuItem({type: 'separator'}));
    menu.append(new MenuItem({label: 'Close Tab', click: () => this.props.onClose?.()}));
    menu.popup();
    /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call */
  };

  render() {
    const {url, onClose, hasSession} = this.props;
    const {error, loading} = this.state;

    return (
      <div
        onContextMenu={this.handleContextMenu}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: '#0a0a12'
        }}
      >
        {/* Loading spinner — overlay, no bar */}
        {loading && (
          <div
            style={{
              position: 'absolute',
              top: 6,
              right: 10,
              fontSize: 11,
              color: '#4af',
              zIndex: 10,
              pointerEvents: 'none',
              animation: 'web-pane-spin 1s linear infinite'
            }}
          >
            ⟳
          </div>
        )}
        {/* Overlay × for terminal-overlay mode */}
        {hasSession && (
          <span
            onClick={onClose}
            title="Close web pane"
            style={{
              position: 'absolute',
              top: 6,
              right: loading ? 28 : 10,
              fontSize: 14,
              color: '#445',
              cursor: 'pointer',
              zIndex: 10,
              lineHeight: 1,
              padding: '0 2px'
            }}
            onMouseEnter={(e) => ((e.target as HTMLElement).style.color = '#e08080')}
            onMouseLeave={(e) => ((e.target as HTMLElement).style.color = '#445')}
          >
            ×
          </span>
        )}

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
        {/* eslint-disable react/no-unknown-property */}
        <webview
          ref={this.webviewRef}
          src={url}
          useragent={BROWSER_UA}
          style={{flex: 1, display: error ? 'none' : 'flex'}}
        />
        {/* eslint-enable react/no-unknown-property */}

        <style>{`
          @keyframes web-pane-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>
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
