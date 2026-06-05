import React from 'react';
import type { WebHistoryEntry } from './web-pane';
import { faviconForUrl, historyRootKey, isValidUrl } from '../utils/web-pane-helpers';
import rpc from '../rpc';

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
  aiConversations: Array<{ id: string; title: string; messages: any[] }>;
  webHistory: WebHistoryEntry[];
  saveHistory: boolean;
  loading: boolean;
  hasAiConfigured: boolean;
  expandedHistoryRoots: { [key: string]: boolean };

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
  const { url } = props;
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
        <span style={{ textDecoration: 'underline', textUnderlineOffset: '2px' }}>{matched}</span>
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
        <span style={{ textDecoration: 'underline', textUnderlineOffset: '2px' }}>
          {text.substring(idx, idx + q.length)}
        </span>
        {text.substring(idx + q.length)}
      </span>
    );
  };

  const getHistoryVisibleRows = (q: string) => {
    const filtered = q
      ? props.webHistory.filter(
          (item) =>
            item.value.toLowerCase().includes(q) ||
            (item.titleAtVisit && item.titleAtVisit.toLowerCase().includes(q))
        )
      : props.webHistory;
    const order: string[] = [];
    const groups: { [k: string]: WebHistoryEntry[] } = {};
    for (const item of filtered) {
      const key = item.kind === 'url' ? historyRootKey(item.value) : `__solo__${item.value}-${item.visitedAt}`;
      if (!groups[key]) {
        groups[key] = [];
        order.push(key);
      }
      groups[key].push(item);
    }
    const rows: Array<
      | { type: 'single' | 'child'; item: WebHistoryEntry }
      | { type: 'root'; key: string; label: string; entries: WebHistoryEntry[] }
    > = [];
    for (const key of order) {
      const entries = groups[key];
      if (entries.length === 1) {
        rows.push({ type: 'single', item: entries[0] });
      } else {
        rows.push({ type: 'root', key, label: key.replace(/^https?:\/\//, ''), entries });
        if (props.expandedHistoryRoots[key] || !!q) {
          for (const item of entries) rows.push({ type: 'child', item });
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
      props.onUpdateState({ isUrlNavigatorOpen: false });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length > 0) {
        const nextIndex = (props.navigatorFocusedIndex + 1) % filtered.length;
        props.onUpdateState({ navigatorFocusedIndex: nextIndex });
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length > 0) {
        const prevIndex =
          props.navigatorFocusedIndex <= 0 ? filtered.length - 1 : props.navigatorFocusedIndex - 1;
        props.onUpdateState({ navigatorFocusedIndex: prevIndex });
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
        props.onUpdateState({ isUrlNavigatorOpen: false });
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
            props.onUpdateState({ isUrlNavigatorOpen: false });
          } else {
            if (!props.hasAiConfigured) {
              props.onUpdateState({ navigatorError: 'AI not configured — please check settings' });
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
            props.onUpdateState({ isUrlNavigatorOpen: false });
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
            props.onUpdateState({ navigatorError: 'AI not configured — please check settings' });
            return;
          }
          const conversationId = 'conv-' + Date.now();
          props.onCreateConversation(conversationId, trimmed);
          props.onNavigate(`ai://${conversationId}`);
        }
      }
    }
    props.onUpdateState({ isUrlNavigatorOpen: false });
  };

  const renderUrlBreadcrumbs = () => {
    const currentUrl = isAi ? 'AI Chat' : (props as any).activeUrl || props.url || 'about:blank';

    if (isAi) {
      const conversationId = url.slice(5);
      const conv = props.aiConversations.find((c) => c.id === conversationId);
      const title = conv ? conv.title : 'AI Conversation';
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-6)',
            padding: 'var(--space-8) var(--space-12)',
            borderBottom: '0.5px solid var(--border-neutral)',
            background: 'var(--bg-dim)',
            fontSize: '11px',
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-sans)',
            fontWeight: 500,
            userSelect: 'none'
          }}
        >
          <i className="ti ti-sparkles" style={{ color: 'var(--color-ai-purple, #7F77DD)', marginRight: '4px' }} />
          <span>AI Chat</span>
          <span style={{ color: 'var(--text-tertiary)' }}>&gt;</span>
          <span style={{ color: 'var(--text-primary)' }}>{title}</span>
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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-6)',
            padding: 'var(--space-8) var(--space-12)',
            borderBottom: '0.5px solid var(--border-neutral)',
            background: 'var(--bg-dim)',
            fontSize: '11px',
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono)',
            userSelect: 'none'
          }}
        >
          <i className="ti ti-world" style={{ color: 'var(--info-text)', marginRight: '4px' }} />
          <span style={{ color: 'var(--text-primary)', wordBreak: 'break-all', overflowWrap: 'anywhere', minWidth: 0 }}>
            {currentUrl}
          </span>
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
      hops.push({ name: hostParts[i], url: rootUrl, title: `Go to ${rootUrl}` });
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
      hops.push({ name: hash, url: currentUrl, title: `Fragment ${hash}` });
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
      <div
        className="web_navigatorBreadcrumbs"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--space-4)',
          padding: 'var(--space-8) var(--space-12)',
          borderBottom: '0.5px solid var(--border-neutral)',
          background: 'var(--bg-dim)',
          fontSize: '11px',
          color: 'var(--text-secondary)',
          fontFamily: 'var(--font-mono)',
          userSelect: 'none',
          maxWidth: '100%',
          boxSizing: 'border-box',
          overflowX: 'hidden'
        }}
      >
        <span
          onClick={() => {
            props.onNavigate(rootUrl);
            props.onUpdateState({ isUrlNavigatorOpen: false });
          }}
          style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', color: 'var(--text-secondary)' }}
          title={`Go to root site: ${rootUrl}`}
        >
          <i className="ti ti-world" style={{ fontSize: '13px' }} aria-hidden="true" />
        </span>
        {hops.map((hop, index) => {
          const isLast = index === hops.length - 1;
          return (
            <React.Fragment key={index}>
              <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>/</span>
              {isLast ? (
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-primary)',
                    fontWeight: 500,
                    fontFamily: 'var(--font-mono)',
                    wordBreak: 'break-all',
                    overflowWrap: 'anywhere',
                    minWidth: 0,
                    maxWidth: '100%'
                  }}
                >
                  {hop.name}
                </span>
              ) : (
                <span
                  onClick={() => {
                    props.onNavigate(hop.url);
                    props.onUpdateState({ isUrlNavigatorOpen: false });
                  }}
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                    cursor: 'pointer',
                    wordBreak: 'break-all',
                    overflowWrap: 'anywhere',
                    minWidth: 0,
                    maxWidth: '100%'
                  }}
                  className="web_breadcrumbHop"
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
            <span
              style={{
                fontSize: '11px',
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono)',
                marginLeft: '2px'
              }}
            >
              ?
            </span>
            {varKeys.map((k, vi) => (
              <React.Fragment key={'var-' + vi}>
                {vi > 0 && (
                  <span
                    style={{
                      fontSize: '11px',
                      color: 'var(--text-tertiary)',
                      fontFamily: 'var(--font-mono)',
                      opacity: 0.6
                    }}
                  >
                    ·
                  </span>
                )}
                <span
                  title={`Query variable: ${k}`}
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                    opacity: 0.75,
                    wordBreak: 'break-all',
                    minWidth: 0
                  }}
                >
                  {k}
                </span>
              </React.Fragment>
            ))}
          </React.Fragment>
        )}
      </div>
    );
  };

  const renderHistoryRootRow = (
    row: { key: string; label: string; entries: WebHistoryEntry[] },
    index: number
  ) => {
    const isFocused = index === props.navigatorFocusedIndex;
    const expanded = !!props.expandedHistoryRoots[row.key];
    const sample = row.entries[0];
    return (
      <div
        key={`root-${row.key}`}
        onClick={(e) => {
          e.stopPropagation();
          props.onUpdateState({
            expandedHistoryRoots: {
              ...props.expandedHistoryRoots,
              [row.key]: !props.expandedHistoryRoots[row.key]
            }
          });
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 12px',
          cursor: 'pointer',
          background: isFocused ? 'var(--info-bg)' : undefined
        }}
        className={isFocused ? 'term_navigatorDirRow_focused' : 'term_navigatorDirRow'}
      >
        <i
          className={expanded ? 'ti ti-chevron-down' : 'ti ti-chevron-right'}
          style={{ fontSize: '12px', color: 'var(--text-tertiary)', flexShrink: 0 }}
          aria-hidden="true"
        />
        <span
          style={{
            position: 'relative',
            width: '14px',
            height: '14px',
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <i
            className="ti ti-world"
            style={{ fontSize: '13px', color: isFocused ? 'var(--info-text)' : 'var(--text-tertiary)' }}
            aria-hidden="true"
          />
          <img
            src={faviconForUrl(sample.value)}
            width={14}
            height={14}
            alt=""
            style={{ position: 'absolute', inset: 0, borderRadius: '2px', objectFit: 'contain' }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            fontWeight: 600,
            color: isFocused ? 'var(--info-text)' : 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1
          }}
        >
          {row.label}
        </span>
        <span
          style={{
            fontSize: '10px',
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-sans)',
            flexShrink: 0,
            marginRight: 'var(--space-6)'
          }}
        >
          {row.entries.length}
        </span>
      </div>
    );
  };

  const renderHistoryRow = (
    item: WebHistoryEntry,
    index: number,
    q: string,
    indent = false
  ) => {
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
            props.onNavigate(item.value);
          }
          props.onUpdateState({ isUrlNavigatorOpen: false });
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: indent ? '5px 12px 5px 32px' : '6px 12px',
          cursor: 'pointer',
          background: isFocused ? 'var(--info-bg)' : undefined,
          transition: 'background 0.1s ease'
        }}
        className={isFocused ? 'term_navigatorDirRow_focused' : 'term_navigatorDirRow'}
      >
        {isAiRow ? (
          <i
            className="ti ti-sparkles"
            style={{
              fontSize: '13px',
              color: isFocused ? 'var(--info-text)' : 'var(--color-ai-purple, #7F77DD)',
              flexShrink: 0
            }}
          />
        ) : (
          <span
            style={{
              position: 'relative',
              width: '14px',
              height: '14px',
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <i
              className="ti ti-world"
              style={{ fontSize: '13px', color: isFocused ? 'var(--info-text)' : 'var(--text-tertiary)' }}
              aria-hidden="true"
            />
            <img
              src={faviconForUrl(item.value)}
              width={14}
              height={14}
              alt=""
              style={{ position: 'absolute', inset: 0, borderRadius: '2px', objectFit: 'contain' }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          </span>
        )}
        <span
          style={{
            fontFamily: isAiRow ? 'var(--font-sans)' : 'var(--font-mono)',
            fontSize: '11px',
            color: isFocused
              ? isAiRow
                ? 'var(--color-ai-purple, #7F77DD)'
                : 'var(--info-text)'
              : 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            flex: 1
          }}
        >
          {item.titleAtVisit ? (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-6)',
                minWidth: 0,
                maxWidth: '100%',
                overflow: 'hidden'
              }}
            >
              <span
                title={item.titleAtVisit}
                style={{
                  fontWeight: 600,
                  maxWidth: '45%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flexShrink: 0
                }}
              >
                {highlightHistory(item.titleAtVisit, q)}
              </span>
              <span
                title={item.value}
                style={{
                  color: 'var(--text-tertiary)',
                  fontSize: '10px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                  flex: 1
                }}
              >
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
          className="web-navigator-row-delete"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '18px',
            height: '18px',
            borderRadius: '50%',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            transition: 'background 0.15s, color 0.15s',
            marginLeft: 'var(--space-6)',
            flexShrink: 0
          }}
          title="Delete from history"
        >
          <i className="ti ti-x" style={{ fontSize: '10px' }} aria-hidden="true" />
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
    let statusColor = 'var(--text-tertiary)';

    if (isTyping && val.trim()) {
      const trimmed = val.trim();
      const isUrl = isValidUrl(trimmed);
      const hasAi = props.hasAiConfigured;

      if (isAi) {
        statusText = '✨ AI query · Enter starts new thread';
      } else if (isUrl) {
        statusText = '🌐 URL · Enter navigates';
      } else if (!hasAi) {
        statusText = '✨ AI not configured — see settings';
        statusColor = 'var(--warning-text)';
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
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          borderTop: '0.5px solid var(--border-neutral)',
          background: 'var(--bg-primary)',
          borderBottomLeftRadius: '4px',
          borderBottomRightRadius: '4px',
          boxSizing: 'border-box'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-8)',
            padding: 'var(--space-8) var(--space-12)',
            boxSizing: 'border-box'
          }}
        >
          {props.loading && url ? (
            <span
              style={{
                fontSize: '11px',
                display: 'inline-block',
                animation: 'web-pane-spin 1s linear infinite',
                opacity: 0.6,
                flexShrink: 0
              }}
            >
              ⟳
            </span>
          ) : (
            <i
              className="ti ti-search"
              style={{
                fontSize: '13px',
                color: 'var(--text-tertiary)',
                flexShrink: 0
              }}
              aria-hidden="true"
            />
          )}
          <input
            ref={props.navigatorInputRef}
            type="text"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontSize: '11px',
              fontFamily: isAi || (val.trim() && !isValidUrl(val)) ? 'var(--font-sans)' : 'var(--font-mono)',
              height: '24px',
              padding: 0
            }}
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
                const { Menu, MenuItem } = require('@electron/remote');
                const menu = new Menu();
                menu.append(new MenuItem({ role: 'cut' }));
                menu.append(new MenuItem({ role: 'copy' }));
                menu.append(new MenuItem({ role: 'paste' }));
                menu.append(new MenuItem({ type: 'separator' }));
                menu.append(new MenuItem({ role: 'selectAll' }));
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
            style={{
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-4)',
              fontSize: '10px',
              fontWeight: 600,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-info)',
              border: '0.5px solid var(--border-neutral)',
              borderRadius: 'var(--radius-3)',
              padding: '1px var(--space-6)',
              background: 'var(--bg-secondary)',
              userSelect: 'none',
              whiteSpace: 'nowrap'
            }}
            title="Navigate (Enter)"
          >
            enter
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '4px 12px 6px 12px',
            fontSize: '9px',
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-sans)',
            userSelect: 'none',
            borderTop: '0.5px solid rgba(255, 255, 255, 0.03)',
            gap: 'var(--space-12)'
          }}
        >
          <span>{statusText}</span>

          <div
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', marginRight: '12px' }}
            title={props.saveHistory ? 'History saving is enabled' : 'History saving is disabled (Private mode)'}
          >
            <span style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>Save History</span>
            <label
              className="web_historyToggle"
              style={{
                position: 'relative',
                display: 'inline-block',
                width: '24px',
                height: '13px',
                cursor: 'pointer',
                userSelect: 'none',
                margin: 0
              }}
            >
              <input
                type="checkbox"
                checked={props.saveHistory}
                onChange={props.onToggleSaveHistory}
                style={{
                  opacity: 0,
                  width: 0,
                  height: 0,
                  margin: 0,
                  position: 'absolute'
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: props.saveHistory ? 'var(--text-info, #007aff)' : 'var(--bg-tertiary, #3e3e3f)',
                  borderRadius: '13px',
                  transition: 'background-color 0.2s ease-in-out'
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  content: '""',
                  height: '9px',
                  width: '9px',
                  left: props.saveHistory ? '13px' : '2px',
                  bottom: '2px',
                  backgroundColor: '#ffffff',
                  borderRadius: '50%',
                  transition: 'left 0.2s ease-in-out',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
                }}
              />
            </label>
          </div>

          <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>Esc to close</span>
        </div>
      </div>
    );
  };

  const rows = getHistoryVisibleRows(activeQuery);

  return (
    <div
      ref={props.urlNavigatorRef}
      style={{
        position: 'absolute',
        top: `${props.navigatorTop ?? 38}px`,
        left: `${props.navigatorLeft ?? 8}px`,
        width: `${props.navigatorWidth ?? 320}px`,
        minWidth: '320px',
        background: 'var(--bg-secondary)',
        border: '0.5px solid var(--border-neutral)',
        borderRadius: '4px',
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box'
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Top: Premium breadcrumbs header */}
      {renderUrlBreadcrumbs()}

      {/* Error Message if invalid */}
      {props.navigatorError && (
        <div
          style={{
            padding: '4px 12px',
            fontSize: '10px',
            color: 'var(--danger-text)',
            background: 'var(--danger-bg)',
            borderBottom: '0.5px solid var(--border-neutral)',
            fontFamily: 'var(--font-sans)'
          }}
        >
          {props.navigatorError}
        </div>
      )}

      {/* Body: history list */}
      <div
        style={{
          maxHeight: '200px',
          overflowY: 'auto'
        }}
      >
        {isAi ? (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 12px 4px 12px',
                borderBottom: '0.5px solid var(--border-neutral)',
                background: 'var(--bg-dim)',
                userSelect: 'none'
              }}
            >
              <span
                style={{
                  fontSize: '9px',
                  fontWeight: 600,
                  color: 'var(--text-tertiary)',
                  letterSpacing: '0.5px',
                  fontFamily: 'var(--font-sans)'
                }}
              >
                RECENT THREADS
              </span>
              {props.aiConversations.length > 0 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm('Clear all AI conversation threads?')) {
                      props.onClearAllAiConversations();
                    }
                  }}
                  className="web-navigator-clear-all"
                  style={{
                    fontSize: '9px',
                    fontWeight: 600,
                    color: 'var(--danger-text)',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                    fontFamily: 'var(--font-sans)'
                  }}
                  title="Clear all threads"
                >
                  Clear All
                </span>
              )}
            </div>
            {props.aiConversations.length === 0 ? (
              <div
                style={{
                  padding: '12px',
                  textAlign: 'center',
                  fontSize: '11px',
                  color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-sans)'
                }}
              >
                No threads found
              </div>
            ) : (
              props.aiConversations.map((item, index) => {
                const isFocused = index === props.navigatorFocusedIndex;
                return (
                  <div
                    key={item.id}
                    onClick={() => {
                      props.onNavigate(`ai://${item.id}`);
                      props.onUpdateState({ isUrlNavigatorOpen: false });
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 12px',
                      cursor: 'pointer',
                      background: isFocused ? 'var(--info-bg)' : undefined,
                      transition: 'background 0.1s ease'
                    }}
                    className={isFocused ? 'term_navigatorDirRow_focused' : 'term_navigatorDirRow'}
                  >
                    <i
                      className="ti ti-sparkles"
                      style={{
                        fontSize: '13px',
                        color: 'var(--color-ai-purple, #7F77DD)',
                        flexShrink: 0
                      }}
                    />
                    <span
                      style={{
                        fontFamily: 'var(--font-sans)',
                        fontSize: '11px',
                        color: isFocused ? 'var(--color-ai-purple, #7F77DD)' : 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        userSelect: 'none',
                        flex: 1
                      }}
                    >
                      {highlightMatch(item.title, activeQuery)}
                    </span>
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onRemoveAiConversation(item.id);
                      }}
                      className="web-navigator-row-delete"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '18px',
                        height: '18px',
                        borderRadius: '50%',
                        color: 'var(--text-tertiary)',
                        cursor: 'pointer',
                        transition: 'background 0.15s, color 0.15s',
                        marginLeft: 'var(--space-6)',
                        flexShrink: 0
                      }}
                      title="Delete thread"
                    >
                      <i className="ti ti-x" style={{ fontSize: '10px' }} aria-hidden="true" />
                    </div>
                  </div>
                );
              })
            )}
          </>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 12px 4px 12px',
                borderBottom: '0.5px solid var(--border-neutral)',
                background: 'var(--bg-dim)',
                userSelect: 'none'
              }}
            >
              <span
                style={{
                  fontSize: '9px',
                  fontWeight: 600,
                  color: 'var(--text-tertiary)',
                  letterSpacing: '0.5px',
                  fontFamily: 'var(--font-sans)'
                }}
              >
                BROWSER HISTORY
              </span>
              {rows.length > 0 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm('Clear all browser history?')) {
                      props.onClearAllHistory();
                    }
                  }}
                  className="web-navigator-clear-all"
                  style={{
                    fontSize: '9px',
                    fontWeight: 600,
                    color: 'var(--danger-text)',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                    fontFamily: 'var(--font-sans)'
                  }}
                  title="Clear all history"
                >
                  Clear All
                </span>
              )}
            </div>
            {rows.length === 0 ? (
              <div
                style={{
                  padding: '12px',
                  textAlign: 'center',
                  fontSize: '11px',
                  color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-sans)'
                }}
              >
                No history matches
              </div>
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
