import React from 'react';

import {connect} from 'react-redux';

import type {HyperDispatch} from '../../typings/hyper';
import {setWebPane} from '../actions/term-groups';

interface WebPaneProps {
  url: string;
  groupUid: string;
  onClose: () => void;
}

class WebPane_ extends React.PureComponent<WebPaneProps> {
  webviewRef = React.createRef<any>();

  render() {
    const {url, onClose} = this.props;
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: '#fff'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 8px',
            background: '#1a1a2e',
            borderBottom: '1px solid #0d0d1a',
            flexShrink: 0,
            height: 28,
            WebkitAppRegion: 'no-drag'
          } as React.CSSProperties}
        >
          <span style={{fontSize: 11, color: '#888', flexShrink: 0}}>🌐</span>
          <span
            style={{
              flex: 1,
              fontSize: 11,
              color: '#aaa',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: 'inherit'
            }}
            title={url}
          >
            {url}
          </span>
          <span
            onClick={onClose}
            title="Close web pane"
            style={{
              fontSize: 14,
              color: '#666',
              cursor: 'pointer',
              flexShrink: 0,
              lineHeight: 1,
              padding: '0 2px'
            }}
            onMouseEnter={(e) => ((e.target as HTMLElement).style.color = '#e08080')}
            onMouseLeave={(e) => ((e.target as HTMLElement).style.color = '#666')}
          >
            ×
          </span>
        </div>
        {/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */}
        {/* @ts-ignore — webview is a valid Electron tag but not in React types */}
        <webview ref={this.webviewRef} src={url} style={{flex: 1}} />
      </div>
    );
  }
}

const mapDispatchToProps = (dispatch: HyperDispatch, ownProps: {groupUid: string}) => ({
  onClose() {
    dispatch(setWebPane(null) as any);
  }
});

export default connect(null, mapDispatchToProps)(WebPane_);
