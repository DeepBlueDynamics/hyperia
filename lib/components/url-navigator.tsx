import React from 'react';

import rpc from '../rpc';
import {faviconForUrl, historyRootKey, isValidUrl} from '../utils/web-pane-helpers';

import type {WebHistoryEntry} from './web-pane';

import './url-navigator.css';

export interface UrlNavigatorProps {
  url: string;
  sessionUid?: string | null;
  groupUid: string;
  navigatorTop?: number;
  navigatorLeft?: number;
  navigatorWidth?: number;
  navigatorInputVal: string;
  navigatorFocusedIndex: number;
  navigatorError: string | null;
  aiConversations: Array<{id: string; title: string; messages: any[]}>;
  webHistory: WebHistoryEntry[];
  saveHistory: boolean;
  loading: boolean;
  hasAiConfigured: boolean;
  expandedHistoryRoots: {[key: string]: boolean};

  navigatorInputRef: React.RefObject<HTMLInputElement>;
  urlNavigatorRef: React.RefObject<HTMLDivElement>;

  onUpdateState: (updates: any) => void;
  onNavigate: (url: string) => void;
  onCreateConversation: (id: string, query: string) => void;
  onClearAllHistory: () => void;
  onClearAllAiConversations: () => void;
  onRemoveAiConversation: (id: string) => void;
  onRemoveHistoryEntry: (kind: 'url' | 'ai-query', value: string, visitedAt: number) => void;
  onToggleSaveHistory: () => void;
}

export const UrlNavigator: React.FC<UrlNavigatorProps> = (props) => {
  const {url} = props;
  const isAi = !!(url && url.startsWith('ai://'));
  const val = props.navigatorInputVal;
  const query = val.toLowerCase().trim();

  const isInitialUrl =
    props.navigatorInputVal === props.url ||
    (props.navigatorInputVal && props.navigatorInputVal === (props as any).activeUrl);
  const activeQuery = isInitialUrl ? '' : props.navigatorInputVal.toLowerCase().trim();

  const highlightMatch = (text: string, q: string) => {
    if (!q) return <span>{text}</span>;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return <span>{text}</span>;

    const before = text.substring(0, idx);
    const matched = text.substring(idx, idx + q.length);
    const after = text.substring(idx + q.length);

    return (
      <span>
        {before}
        <span className="hy-urlnav-match">{matched}</span>
        {after}
      </span>
    );
  };

  const highlightHistory = (text: string, q: string): React.ReactNode => {
    if (!q) return <span>{text}</span>;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return <span>{text}</span>;
    return (
      <span>
        {text.substring(0, idx)}
        <span className="hy-urlnav-match">{text.substring(idx, idx + q.length)}</span>
        {text.substring(idx + q.length)}
      </span>
    );
  };

  const getHistoryVisibleRows = (q: string) => {
    const filtered = q
      ? props.webHistory.filter(
          (item) =>
            item.value.toLowerCase().includes(q) || (item.titleAtVisit && item.titleAtVisit.toLowerCase().includes(q))
        )
      : props.webHistory;
    const order: string[] = [];
    const groups: {[k: string]: WebHistoryEntry[]} = {};
    for (const item of filtered) {
      const key = item.kind === 'url' ? historyRootKey(item.value) : `__solo__${item.value}-${item.visitedAt}`;
      if (!groups[key]) {
        groups[key] = [];
        order.push(key);
      }
      groups[key].push(item);
    }
    const rows: Array<
      | {type: 'single' | 'child'; item: WebHistoryEntry}
      | {type: 'root'; key: string; label: string; entries: WebHistoryEntry[]}
    > = [];
    for (const key of order) {
      const entries = groups[key];
      // Shortest URL first inside a group — site root on top, deep pages after.
      entries.sort((a, b) => a.value.length - b.value.length);
      if (entries.length === 1) {
        rows.push({type: 'single', item: entries[0]});
      } else {
        rows.push({type: 'root', key, label: key.replace(/^https?:\/\//, ''), entries});
        if (props.expandedHistoryRoots[key] || !!q) {
          for (const item of entries) rows.push({type: 'child', item});
        }
      }
    }
    return rows;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const queryLower = val.toLowerCase();
    const filtered = isAi
      ? queryLower
        ? props.aiConversations.filter((c) => c.title.toLowerCase().includes(queryLower))
        : props.aiConversations
      : queryLower
        ? props.webHistory.filter((item) => item.value.toLowerCase().includes(queryLower))
        : props.webHistory;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onUpdateState({isUrlNavigatorOpen: false});
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length > 0) {
        const nextIndex = (props.navigatorFocusedIndex + 1) % filtered.length;
        props.onUpdateState({navigatorFocusedIndex: nextIndex});
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length > 0) {
        const prevIndex = props.navigatorFocusedIndex <= 0 ? filtered.length - 1 : props.navigatorFocusedIndex - 1;
        props.onUpdateState({navigatorFocusedIndex: prevIndex});
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const idx = props.navigatorFocusedIndex;
      if (idx >= 0 && idx < filtered.length) {
        const item = filtered[idx] as any;
        if (item.kind === 'ai-query' || item.id) {
          const conversationId = item.conversationId || item.id || `conv-${Date.now()}`;
          if (e.shiftKey) {
            const newConvId = `conv-${Date.now()}`;
            props.onCreateConversation(newConvId, item.value || item.title);
            const isCurrentPaneEmpty = !props.url || props.url === 'about:blank' || props.url === '';
            if (isCurrentPaneEmpty) {
              props.onNavigate(`ai://${newConvId}`);
            } else {
              rpc.emit('split request vertical', {
                activeUid: props.sessionUid || props.groupUid,
                profile: 'Web Pane',
                url: `ai://${newConvId}`
              });
            }
          } else {
            props.onNavigate(`ai://${conversationId}`);
          }
        } else {
          props.onNavigate(item.value);
        }
        props.onUpdateState({isUrlNavigatorOpen: false});
      } else {
        const trimmed = val.trim();
        if (trimmed) {
          const isUrl = isValidUrl(trimmed);
          const forceUrl = e.ctrlKey || e.metaKey;

          if (isUrl || forceUrl) {
            let finalUrl = trimmed;
            if (!/^https?:\/\//i.test(finalUrl)) {
              if (/^(localhost|127\.0\.0\.1)/i.test(finalUrl)) {
                finalUrl = 'http://' + finalUrl;
              } else {
                finalUrl = 'https://' + finalUrl;
              }
            }
            props.onNavigate(finalUrl);
            props.onUpdateState({isUrlNavigatorOpen: false});
          } else {
            if (!props.hasAiConfigured) {
              // No AI configured → a bare (non-URL) query becomes a web search.
              props.onNavigate('https://duckduckgo.com/?q=' + encodeURIComponent(trimmed));
              props.onUpdateState({isUrlNavigatorOpen: false});
              return;
            }

            const conversationId = 'conv-' + Date.now();
            props.onCreateConversation(conversationId, trimmed);

            const isCurrentPaneEmpty = !props.url || props.url === 'about:blank' || props.url === '';
            if (isCurrentPaneEmpty) {
              props.onNavigate(`ai://${conversationId}`);
            } else {
              rpc.emit('split request vertical', {
                activeUid: props.sessionUid || props.groupUid,
                profile: 'Web Pane',
                url: `ai://${conversationId}`
              });
            }
            props.onUpdateState({isUrlNavigatorOpen: false});
          }
        }
      }
    }
  };

  const handleGo = () => {
    const idx = props.navigatorFocusedIndex;
    const filteredList = isAi
      ? query
        ? props.aiConversations.filter((c) => c.title.toLowerCase().includes(query))
        : props.aiConversations
      : query
        ? props.webHistory.filter((item) => item.value.toLowerCase().includes(query))
        : props.webHistory;

    if (idx >= 0 && idx < filteredList.length) {
      const item = filteredList[idx] as any;
      if (item.kind === 'ai-query') {
        const conversationId = item.conversationId || `conv-${Date.now()}`;
        props.onNavigate(`ai://${conversationId}`);
      } else {
        const value = item.value || item.title;
        if (item.id) {
          props.onNavigate(`ai://${item.id}`);
        } else {
          props.onNavigate(value);
        }
      }
    } else {
      const trimmed = val.trim();
      if (trimmed) {
        const isUrl = isValidUrl(trimmed);
        if (isUrl) {
          let finalUrl = trimmed;
          if (!/^https?:\/\//i.test(finalUrl)) {
            if (/^(localhost|127\.0\.0\.1)/i.test(finalUrl)) {
              finalUrl = 'http://' + finalUrl;
            } else {
              finalUrl = 'https://' + finalUrl;
            }
          }
          props.onNavigate(finalUrl);
        } else {
          if (!props.hasAiConfigured) {
            // No AI configured → a bare (non-URL) query becomes a web search.
            props.onNavigate('https://duckduckgo.com/?q=' + encodeURIComponent(trimmed));
            props.onUpdateState({isUrlNavigatorOpen: false});
            return;
          }
          const conversationId = 'conv-' + Date.now();
          props.onCreateConversation(conversationId, trimmed);
          props.onNavigate(`ai://${conversationId}`);
        }
      }
    }
    props.onUpdateState({isUrlNavigatorOpen: false});
  };

  const renderUrlBreadcrumbs = () => {
    const currentUrl = isAi ? 'AI Chat' : (props as any).activeUrl || props.url || 'about:blank';

    if (isAi) {
      const conversationId = url.slice(5);
      const conv = props.aiConversations.find((c) => c.id === conversationId);
      const title = conv ? conv.title : 'AI Conversation';
      return (
        <div className="hy-urlnav-crumbs is-ai">
          <i className="ti ti-sparkles hy-urlnav-crumbs-ai-icon" />
          <span>AI Chat</span>
          <span className="hy-urlnav-dim">&gt;</span>
          <span className="hy-urlnav-bright">{title}</span>
        </div>
      );
    }

    let protocol = 'https';
    let hostname = 'about:blank';
    let pathname = '';
    let port = '';
    let search = '';
    let hash = '';
    let showHops = false;
    try {
      const parsed = new URL(/^https?:\/\//i.test(currentUrl) ? currentUrl : 'https://' + currentUrl);
      protocol = parsed.protocol.replace(':', '');
      hostname = parsed.hostname;
      port = parsed.port;
      pathname = parsed.pathname;
      search = parsed.search;
      hash = parsed.hash;
      showHops = true;
    } catch (e) {
      // invalid URL
    }

    if (!showHops) {
      return (
        <div className="hy-urlnav-crumbs">
          <i className="ti ti-world hy-urlnav-crumbs-url-icon" />
          <span className="hy-urlnav-crumbs-raw">{currentUrl}</span>
        </div>
      );
    }

    const rootUrl = `${protocol}://${hostname}${port ? `:${port}` : ''}`;
    const hops: {
      name: string;
      url: string;
      title: string;
    }[] = [];

    hops.push({
      name: protocol,
      url: rootUrl,
      title: `Go to ${rootUrl}`
    });

    const hostParts = hostname.split('.').filter(Boolean);
    for (let i = hostParts.length - 1; i >= 0; i--) {
      hops.push({name: hostParts[i], url: rootUrl, title: `Go to ${rootUrl}`});
    }

    if (port) {
      hops.push({
        name: `:${port}`,
        url: `${protocol}://${hostname}:${port}`,
        title: `Go to ${protocol}://${hostname}:${port}`
      });
    }

    const pathSegments = pathname.split('/').filter(Boolean);
    let currentAccumPath = '';
    pathSegments.forEach((seg) => {
      currentAccumPath += '/' + seg;
      hops.push({
        name: seg,
        url: `${protocol}://${hostname}${port ? `:${port}` : ''}${currentAccumPath}`,
        title: `Go to ${protocol}://${hostname}${port ? `:${port}` : ''}${currentAccumPath}`
      });
    });

    if (hash) {
      hops.push({name: hash, url: currentUrl, title: `Fragment ${hash}`});
    }

    const varKeys: string[] = [];
    if (search) {
      try {
        for (const k of new URLSearchParams(search).keys()) {
          if (k && !varKeys.includes(k)) varKeys.push(k);
        }
      } catch (e) {
        // skip
      }
    }

    return (
      <div className="web_navigatorBreadcrumbs hy-urlnav-crumbs is-hops">
        <span
          onClick={() => {
            props.onNavigate(rootUrl);
            props.onUpdateState({isUrlNavigatorOpen: false});
          }}
          className="hy-urlnav-crumbs-root"
          title={`Go to root site: ${rootUrl}`}
        >
          <i className="ti ti-world hy-urlnav-crumbs-root-icon" aria-hidden="true" />
        </span>
        {hops.map((hop, index) => {
          const isLast = index === hops.length - 1;
          return (
            <React.Fragment key={index}>
              <span className="hy-urlnav-sep">/</span>
              {isLast ? (
                <span className="hy-urlnav-hop-last">{hop.name}</span>
              ) : (
                <span
                  onClick={() => {
                    props.onNavigate(hop.url);
                    props.onUpdateState({isUrlNavigatorOpen: false});
                  }}
                  className="web_breadcrumbHop hy-urlnav-hop"
                  title={hop.title}
                >
                  {hop.name}
                </span>
              )}
            </React.Fragment>
          );
        })}
        {varKeys.length > 0 && (
          <React.Fragment>
            <span className="hy-urlnav-query-mark">?</span>
            {varKeys.map((k, vi) => (
              <React.Fragment key={'var-' + vi}>
                {vi > 0 && <span className="hy-urlnav-query-dot">·</span>}
                <span title={`Query variable: ${k}`} className="hy-urlnav-query-var">
                  {k}
                </span>
              </React.Fragment>
            ))}
          </React.Fragment>
        )}
      </div>
    );
  };

  const renderHistoryRootRow = (row: {key: string; label: string; entries: WebHistoryEntry[]}, index: number) => {
    const isFocused = index === props.navigatorFocusedIndex;
    const expanded = !!props.expandedHistoryRoots[row.key];
    const sample = row.entries[0];
    return (
      <div
        key={`root-${row.key}`}
        onClick={(e) => {
          e.stopPropagation();
          // Ctrl/Cmd-click reveals the collapsed ?/#/@ variants; a plain click
          // navigates to the latest visit of this page.
          if (e.ctrlKey || e.metaKey) {
            props.onUpdateState({
              expandedHistoryRoots: {
                ...props.expandedHistoryRoots,
                [row.key]: !props.expandedHistoryRoots[row.key]
              }
            });
          } else {
            props.onNavigate(row.entries[0].value);
          }
        }}
        className={
          (isFocused ? 'term_navigatorDirRow_focused' : 'term_navigatorDirRow') +
          ' hy-urlnav-row' +
          (isFocused ? ' is-focused' : '')
        }
      >
        <i
          className={(expanded ? 'ti ti-chevron-down' : 'ti ti-chevron-right') + ' hy-urlnav-chevron'}
          aria-hidden="true"
        />
        <span className="hy-urlnav-fav">
          <i className="ti ti-world hy-urlnav-fav-globe" aria-hidden="true" />
          <img
            src={faviconForUrl(sample.value)}
            width={14}
            height={14}
            alt=""
            className="hy-urlnav-fav-img"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        </span>
        <span className="hy-urlnav-root-label">{row.label}</span>
        <span className="hy-urlnav-root-count">{row.entries.length}</span>
      </div>
    );
  };

  const renderHistoryRow = (item: WebHistoryEntry, index: number, q: string, indent = false) => {
    const isFocused = index === props.navigatorFocusedIndex;
    const isAiRow = item.kind === 'ai-query';
    return (
      <div
        key={`${item.value}-${item.visitedAt}`}
        onClick={(e) => {
          if (isAiRow) {
            const conversationId = item.conversationId || `conv-${Date.now()}`;
            if (e.shiftKey) {
              const newConvId = `conv-${Date.now()}`;
              props.onCreateConversation(newConvId, item.value);
              const isCurrentPaneEmpty = !props.url || props.url === 'about:blank' || props.url === '';
              if (isCurrentPaneEmpty) {
                props.onNavigate(`ai://${newConvId}`);
              } else {
                rpc.emit('split request vertical', {
                  activeUid: props.sessionUid || props.groupUid,
                  profile: 'Web Pane',
                  url: `ai://${newConvId}`
                });
              }
            } else {
              props.onNavigate(`ai://${conversationId}`);
            }
          } else {
            // Click a URL row → navigate straight there (no extra Enter).
            props.onUpdateState({navigatorFocusedIndex: -1, navigatorError: null});
            props.onNavigate(item.value);
          }
        }}
        className={
          (isFocused ? 'term_navigatorDirRow_focused' : 'term_navigatorDirRow') +
          ' hy-urlnav-row has-fade is-history' +
          (indent ? ' is-child' : '') +
          (isAiRow ? ' is-ai' : '') +
          (isFocused ? ' is-focused' : '')
        }
      >
        {isAiRow ? (
          <i className="ti ti-sparkles hy-urlnav-ai-icon" />
        ) : (
          <span className="hy-urlnav-fav">
            <i className="ti ti-world hy-urlnav-fav-globe" aria-hidden="true" />
            <img
              src={faviconForUrl(item.value)}
              width={14}
              height={14}
              alt=""
              className="hy-urlnav-fav-img"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          </span>
        )}
        <span className="hy-urlnav-label">
          {item.titleAtVisit ? (
            <span className="hy-urlnav-label-split">
              <span title={item.titleAtVisit} className="hy-urlnav-label-title">
                {highlightHistory(item.titleAtVisit, q)}
              </span>
              <span title={item.value} className="hy-urlnav-label-url">
                {highlightHistory(item.value, q)}
              </span>
            </span>
          ) : (
            highlightHistory(item.value, q)
          )}
        </span>
        <div
          onClick={(e) => {
            e.stopPropagation();
            props.onRemoveHistoryEntry(item.kind, item.value, item.visitedAt);
          }}
          className="web-navigator-row-delete hy-urlnav-delete"
          title="Delete from history"
        >
          <i className="ti ti-x hy-urlnav-delete-icon" aria-hidden="true" />
        </div>
      </div>
    );
  };

  const renderUrlNavigatorFooter = () => {
    const filtered = isAi
      ? query
        ? props.aiConversations.filter((c) => c.title.toLowerCase().includes(query))
        : props.aiConversations
      : query
        ? props.webHistory.filter((item) => item.value.toLowerCase().includes(query))
        : props.webHistory;

    const isTyping = val !== (isAi ? '' : (props as any).activeUrl || props.url || '');

    let statusText = '';

    if (isTyping && val.trim()) {
      const trimmed = val.trim();
      const isUrl = isValidUrl(trimmed);
      const hasAi = props.hasAiConfigured;

      if (isAi) {
        statusText = '✨ AI query · Enter starts new thread';
      } else if (isUrl) {
        statusText = '🌐 URL · Enter navigates';
      } else if (!hasAi) {
        statusText = '🦆 Enter searches DuckDuckGo';
      } else {
        const isPlausibleHost = !/\s/.test(trimmed);
        statusText = `✨ AI query · Enter sends to Claude${isPlausibleHost ? ' (Ctrl+Enter to navigate as URL)' : ''}`;
      }
    } else {
      const count = filtered.length;
      statusText = isAi
        ? `${count} ${count === 1 ? 'active thread' : 'active threads'}`
        : `${count} ${count === 1 ? 'recent visit' : 'recent visits'}`;
    }

    return (
      <div className="hy-urlnav-footer">
        <div className="hy-urlnav-inputbar">
          {props.loading && url ? (
            <span className="hy-urlnav-spinner">⟳</span>
          ) : (
            <i className="ti ti-search hy-urlnav-search-icon" aria-hidden="true" />
          )}
          <input
            ref={props.navigatorInputRef}
            type="text"
            // The navigator mounts fresh each time it pops open — autoFocus puts
            // the cursor straight in the search/URL box so you can type
            // immediately (more reliable than the rAF focus, which can miss).
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            className={'hy-urlnav-input' + (isAi || (val.trim() && !isValidUrl(val)) ? ' is-sans' : '')}
            placeholder={
              isAi ? 'Search threads or ask a new question...' : 'Search history or type URL... (Esc to close)'
            }
            value={props.navigatorInputVal}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              try {
                props.navigatorInputRef.current?.focus();
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const {Menu, MenuItem} = require('@electron/remote');
                const menu = new Menu();
                menu.append(new MenuItem({role: 'cut'}));
                menu.append(new MenuItem({role: 'copy'}));
                menu.append(new MenuItem({role: 'paste'}));
                menu.append(new MenuItem({type: 'separator'}));
                menu.append(new MenuItem({role: 'selectAll'}));
                menu.popup();
              } catch (err) {
                console.error('URL input context menu failed:', err);
              }
            }}
            onChange={(e) => {
              const newVal = e.target.value;
              props.onUpdateState({
                navigatorInputVal: newVal,
                navigatorFocusedIndex: -1,
                navigatorError: null
              });
            }}
            onKeyDown={handleKeyDown}
          />
          <span
            onClick={handleGo}
            onMouseDown={(e) => e.preventDefault()}
            className="hy-urlnav-go"
            title="Navigate (Enter)"
          >
            enter
          </span>
        </div>

        <div className="hy-urlnav-status">
          <span>{statusText}</span>

          <div
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="hy-urlnav-save"
            title={props.saveHistory ? 'History saving is enabled' : 'History saving is disabled (Private mode)'}
          >
            <span className="hy-urlnav-save-label">Save History</span>
            <label className={'web_historyToggle hy-urlnav-toggle' + (props.saveHistory ? ' is-on' : '')}>
              <input
                type="checkbox"
                checked={props.saveHistory}
                onChange={props.onToggleSaveHistory}
                className="hy-urlnav-toggle-input"
              />
              <span className="hy-urlnav-toggle-track" />
              <span className="hy-urlnav-toggle-knob" />
            </label>
          </div>

          <span className="hy-urlnav-esc">Esc to close</span>
        </div>
      </div>
    );
  };

  const rows = getHistoryVisibleRows(activeQuery);

  return (
    <div
      ref={props.urlNavigatorRef}
      className="hy-urlnav"
      // Measured placement stays inline.
      style={{
        top: `${props.navigatorTop ?? 38}px`,
        left: `${props.navigatorLeft ?? 8}px`,
        width: `${props.navigatorWidth ?? 320}px`
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Top: Premium breadcrumbs header */}
      {renderUrlBreadcrumbs()}

      {/* Error Message if invalid */}
      {props.navigatorError && <div className="hy-urlnav-error">{props.navigatorError}</div>}

      {/* Body: history list */}
      <div className="hy-urlnav-list">
        {isAi ? (
          <>
            <div className="hy-urlnav-section">
              <span className="hy-urlnav-section-title">RECENT THREADS</span>
              {props.aiConversations.length > 0 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm('Clear all AI conversation threads?')) {
                      props.onClearAllAiConversations();
                    }
                  }}
                  className="web-navigator-clear-all hy-urlnav-clear-all"
                  title="Clear all threads"
                >
                  Clear All
                </span>
              )}
            </div>
            {props.aiConversations.length === 0 ? (
              <div className="hy-urlnav-empty">No threads found</div>
            ) : (
              props.aiConversations.map((item, index) => {
                const isFocused = index === props.navigatorFocusedIndex;
                return (
                  <div
                    key={item.id}
                    onClick={() => {
                      props.onNavigate(`ai://${item.id}`);
                      props.onUpdateState({isUrlNavigatorOpen: false});
                    }}
                    className={
                      (isFocused ? 'term_navigatorDirRow_focused' : 'term_navigatorDirRow') +
                      ' hy-urlnav-row has-fade is-ai' +
                      (isFocused ? ' is-focused' : '')
                    }
                  >
                    <i className="ti ti-sparkles hy-urlnav-ai-icon" />
                    <span className="hy-urlnav-label">{highlightMatch(item.title, activeQuery)}</span>
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onRemoveAiConversation(item.id);
                      }}
                      className="web-navigator-row-delete hy-urlnav-delete"
                      title="Delete thread"
                    >
                      <i className="ti ti-x hy-urlnav-delete-icon" aria-hidden="true" />
                    </div>
                  </div>
                );
              })
            )}
          </>
        ) : (
          <>
            <div className="hy-urlnav-section">
              <span className="hy-urlnav-section-title">BROWSER HISTORY</span>
              {rows.length > 0 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm('Clear all browser history?')) {
                      props.onClearAllHistory();
                    }
                  }}
                  className="web-navigator-clear-all hy-urlnav-clear-all"
                  title="Clear all history"
                >
                  Clear All
                </span>
              )}
            </div>
            {rows.length === 0 ? (
              <div className="hy-urlnav-empty">No history matches</div>
            ) : (
              rows.map((row, index) =>
                row.type === 'root'
                  ? renderHistoryRootRow(row, index)
                  : renderHistoryRow(row.item, index, activeQuery, row.type === 'child')
              )
            )}
          </>
        )}
      </div>

      {/* Footer: Search/URL input entry bar */}
      {renderUrlNavigatorFooter()}

      <style>{`
        .web-navigator-row-delete {
          opacity: 0;
          pointer-events: none;
        }

        .term_navigatorDirRow:hover .web-navigator-row-delete,
        .term_navigatorDirRow_focused:hover .web-navigator-row-delete {
          opacity: 1;
          pointer-events: auto;
        }

        .web-navigator-row-delete:hover {
          background: var(--border-neutral) !important;
          color: var(--danger-text) !important;
        }

        .web-navigator-clear-all:hover {
          opacity: 0.8;
          text-decoration: underline;
        }

        @keyframes web-pane-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
