import {shell} from 'electron';
import React from 'react';

import {connect} from 'react-redux';

import type {HyperDispatch} from '../../typings/hyper';
import {clearWebPane, userExitTermGroup, splitWebPane, popOutPane} from '../actions/term-groups';
import rpc from '../rpc';
import {countPathHorizontalStacks} from '../utils/term-groups';
import {
  BROWSER_UA,
  getSecurityState,
  normalizeUrlKey,
  faviconForUrl,
  isOAuthUrl,
  isValidUrl
} from '../utils/web-pane-helpers';
import {clickFnStr, ghostMouseFnStr} from '../utils/webview-scripts';

import {AskAiView} from './ask-ai-view';
import FindBar from './find-bar';
import {PaneBand} from './pane-band';
import {UrlNavigator} from './url-navigator';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {ipcMain, ipcRenderer} = require('electron');

interface WebPaneProps {
  url: string;
  groupUid: string;
  hasSession?: boolean; // true = overlaying a terminal; show × to restore it
  sessionUid?: string | null;
  splitLabel?: string;
  onClose?: () => void;
  onClosePane?: () => void;
  onSetTitle?: (title: string) => void;
  onSetUrl?: (url: string) => void;
  allTermGroups?: Record<string, any>;
  webName?: string;
  onActive?: () => void;
  onSplitWebPane?: (url: string, direction: 'HORIZONTAL' | 'VERTICAL') => void;
}

export interface WebHistoryEntry {
  kind: 'url' | 'ai-query';
  value: string;
  visitedAt: number;
  securityState?: 'https' | 'http' | 'localhost' | 'error';
  titleAtVisit?: string;
  conversationId?: string;
  firstResponseSnippet?: string;
}

interface WebPaneState {
  error: string | null;
  loading: boolean;
  httpStatus: number | null;
  canGoBack: boolean;
  canGoForward: boolean;
  activeUrl: string;
  isEditingUrl: boolean;
  urlInputVal: string;
  isUrlNavigatorOpen: boolean;
  webHistory: WebHistoryEntry[];
  saveHistory: boolean;
  navigatorInputVal: string;
  navigatorFocusedIndex: number;
  navigatorError: string | null;
  searchQuery: string;
  searchState: 'idle' | 'searching' | 'completed' | 'error';
  searchText: string;
  searchLogs: {
    id: string;
    name: string;
    input?: any;
    output?: string;
    status: 'running' | 'ok' | 'fail';
    expanded?: boolean;
  }[];
  searchStats: {
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    turns: number;
  } | null;
  searchError: string | null;
  hasAiConfigured: boolean;
  aiConversations: {
    id: string;
    title: string;
    messages: {role: 'user' | 'assistant'; content: string; timestamp: number}[];
  }[];
  aiInputVal: string;
  aiStreamingMessage: string;
  paneHistory: string[];
  paneHistoryIndex: number;
  navigatorLeft?: number;
  navigatorWidth?: number;
  navigatorTop?: number;
  isNarrow: boolean;
  paneWidth: number;
  pageBgColor?: string | null;
  // Find-in-page (Ctrl+F) bar.
  findOpen: boolean;
  findText: string;
  findActive: number;
  findTotal: number;
  // Which collapsed history roots (e.g. all "google.com/maps" URLs) are expanded.
  expandedHistoryRoots: {[key: string]: boolean};
}

// Omnibox routing: pass real URLs through (any scheme, or a dotted host like
// example.com), but send plain queries — anything with whitespace or no dotted
// host — to a DuckDuckGo search. A dotted host that LOOKS valid but fails to
// resolve (e.g. news.hackernews.com) is caught later by the did-fail-load fallback.
function toNavigableUrl(input: string): string {
  const t = (input || '').trim();
  if (!t) return t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t; // already has a scheme (http/https/file/ai/…)
  if (/^localhost(:\d+)?(\/|$)/i.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && /^[^\s/]+\.[^\s/]+/.test(t)) return t; // dotted host → navigateWebview adds https://
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(t);
}

// net error codes where the site couldn't be reached → fall back to a DDG search:
// ERR_NAME_NOT_RESOLVED, ERR_NAME_RESOLUTION_FAILED, ERR_ADDRESS_UNREACHABLE, ERR_INVALID_URL.
const DDG_RESOLVE_FAIL = new Set([-105, -137, -109, -300]);

class WebPane_ extends React.PureComponent<WebPaneProps, WebPaneState> {
  webviewRef = React.createRef<any>();
  urlInputRef = React.createRef<HTMLInputElement>();
  urlNavigatorRef = React.createRef<HTMLDivElement>();
  urlBarRef = React.createRef<HTMLDivElement>();
  navigatorInputRef = React.createRef<HTMLInputElement>();
  findInputRef = React.createRef<HTMLInputElement>();
  webWrapperRef = React.createRef<HTMLDivElement>();
  resizeObserver: any = null;
  _windowKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  _findHandler: ((e: any, guestId: number) => void) | null = null;
  _openSplitHandler: ((e: any, guestId: number, url: string) => void) | null = null;
  // OAuth hand-off de-bounce: an MS/Google login bounces through many redirects,
  // each of which would otherwise open its own system-browser tab. Open once.
  _lastOAuthOpenAt = 0;
  searchAbortCtrl: AbortController | null = null;

  constructor(props: WebPaneProps) {
    super(props);
    let webHistory: WebHistoryEntry[] = [];
    let saveHistory = true;

    try {
      const savedSaveHistory = localStorage.getItem('web_pane_save_history');
      if (savedSaveHistory !== null) {
        saveHistory = savedSaveHistory === 'true';
      }
    } catch (err) {
      console.error('Failed to load saveHistory option:', err);
    }

    try {
      const saved = localStorage.getItem('web_pane_history');
      if (saved) {
        const parsed = JSON.parse(saved) as any[];
        webHistory = parsed.map((item: any): WebHistoryEntry => {
          if (item.kind) return item as WebHistoryEntry;
          return {
            kind: 'url',
            value: (item.url as string) || '',
            visitedAt: (item.visitedAt as number) || Date.now(),
            securityState: item.securityState || 'error',
            titleAtVisit: item.titleAtVisit as string
          };
        });
      } else {
        const paneSaved = localStorage.getItem(`web_pane_history_${props.groupUid}`);
        if (paneSaved) {
          const parsed = JSON.parse(paneSaved) as any[];
          webHistory = parsed.map((item: any): WebHistoryEntry => {
            if (item.kind) return item as WebHistoryEntry;
            return {
              kind: 'url',
              value: (item.url as string) || '',
              visitedAt: (item.visitedAt as number) || Date.now(),
              securityState: item.securityState || 'error',
              titleAtVisit: item.titleAtVisit as string
            };
          });
        }
      }
    } catch (err) {
      console.error('Failed to load history:', err);
    }

    let aiConversations: any[] = [];
    try {
      const saved = localStorage.getItem('web_pane_ai_conversations');
      if (saved) {
        aiConversations = JSON.parse(saved);
      }
    } catch (err) {
      console.error('Failed to load AI conversations:', err);
    }

    this.state = {
      error: null,
      loading: true,
      httpStatus: null,
      canGoBack: false,
      canGoForward: false,
      activeUrl: props.url || '',
      isEditingUrl: false,
      urlInputVal: '',
      isUrlNavigatorOpen: false,
      webHistory,
      saveHistory,
      navigatorInputVal: props.url || '',
      navigatorFocusedIndex: -1,
      navigatorError: null,
      searchQuery: '',
      searchState: 'idle',
      searchText: '',
      searchLogs: [],
      searchStats: null,
      searchError: null,
      hasAiConfigured: false,
      aiConversations,
      aiInputVal: '',
      aiStreamingMessage: '',
      paneHistory: props.url ? [props.url] : [],
      paneHistoryIndex: props.url ? 0 : -1,
      navigatorLeft: 8,
      navigatorWidth: 320,
      paneWidth: 999,
      navigatorTop: 38,
      isNarrow: false,
      pageBgColor: null,
      findOpen: false,
      findText: '',
      findActive: 0,
      findTotal: 0,
      expandedHistoryRoots: {}
    };
  }

  labelRef = React.createRef<HTMLDivElement>();
  inputRef = React.createRef<HTMLInputElement>();

  updateNavigationState = () => {
    /* eslint-disable @typescript-eslint/no-unsafe-call */
    if (!this.webviewRef.current) return;
    const wv = this.webviewRef.current;
    try {
      this.setState({
        canGoBack: wv.canGoBack(),
        canGoForward: wv.canGoForward()
      });
    } catch (err) {
      // webview might not be fully initialized yet
    }
    /* eslint-enable @typescript-eslint/no-unsafe-call */
  };

  reloadWebview = (hard: boolean) => {
    /* eslint-disable @typescript-eslint/no-unsafe-call */
    if (!this.webviewRef.current) return;
    const wv = this.webviewRef.current;
    try {
      if (hard) {
        wv.reloadIgnoringCache();
      } else {
        wv.reload();
      }
    } catch (err) {
      console.error('Failed to reload:', err);
    }
    /* eslint-enable @typescript-eslint/no-unsafe-call */
  };

  // Open the current page in the system browser (Chrome). The reliable bail-out
  // when an embedded webview can't clear a bot wall (Cloudflare et al.).
  openInExternal = () => {
    const wv: any = this.webviewRef.current;
    const u = (wv && typeof wv.getURL === 'function' && wv.getURL()) || this.props.url || this.state.urlInputVal || '';
    if (/^https?:\/\//i.test(u)) {
      try {
        shell.openExternal(u);
      } catch (err) {
        console.error('openExternal failed:', err);
      }
    }
  };

  goBack = () => {
    const {url} = this.props;
    const isAi = url && url.startsWith('ai://');
    if (isAi) {
      if (this.state.paneHistoryIndex > 0) {
        const nextIndex = this.state.paneHistoryIndex - 1;
        const targetUrl = this.state.paneHistory[nextIndex];
        this.setState({paneHistoryIndex: nextIndex});
        this.props.onSetUrl?.(targetUrl);
      }
    } else {
      /* eslint-disable @typescript-eslint/no-unsafe-call */
      if (!this.webviewRef.current) return;
      const wv = this.webviewRef.current;
      try {
        if (wv.canGoBack()) {
          wv.goBack();
        }
      } catch (err) {
        console.error('Failed to go back:', err);
      }
      /* eslint-enable @typescript-eslint/no-unsafe-call */
    }
  };

  goForward = () => {
    const {url} = this.props;
    const isAi = url && url.startsWith('ai://');
    if (isAi) {
      if (this.state.paneHistoryIndex < this.state.paneHistory.length - 1) {
        const nextIndex = this.state.paneHistoryIndex + 1;
        const targetUrl = this.state.paneHistory[nextIndex];
        this.setState({paneHistoryIndex: nextIndex});
        this.props.onSetUrl?.(targetUrl);
      }
    } else {
      /* eslint-disable @typescript-eslint/no-unsafe-call */
      if (!this.webviewRef.current) return;
      const wv = this.webviewRef.current;
      try {
        if (wv.canGoForward()) {
          wv.goForward();
        }
      } catch (err) {
        console.error('Failed to go forward:', err);
      }
      /* eslint-enable @typescript-eslint/no-unsafe-call */
    }
  };

  handleKeyDown = (e: React.KeyboardEvent) => {
    let isSplitDownDisabled = false;
    const {groupUid, allTermGroups} = this.props as any;
    if (groupUid && allTermGroups) {
      const stacks = countPathHorizontalStacks(groupUid, allTermGroups);
      if (stacks >= 11) {
        isSplitDownDisabled = true;
      }
    }

    if (this.state.isNarrow && (e.ctrlKey || e.metaKey) && e.key === '|') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (isSplitDownDisabled && (e.ctrlKey || e.metaKey) && (e.key === '_' || e.key === '-')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (isSplitDownDisabled && (e.ctrlKey || e.metaKey) && e.altKey && (e.key === '_' || e.key === '-')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'F5') {
      e.preventDefault();
      e.stopPropagation();
      this.reloadWebview(e.shiftKey);
    }
  };

  navigateWebview = (targetUrl: string) => {
    // Route plain queries / non-URLs to a DuckDuckGo search (keeps ai://, http(s),
    // file, and dotted hosts intact).
    targetUrl = toNavigableUrl(targetUrl);
    if (isOAuthUrl(targetUrl)) {
      void shell.openExternal(targetUrl);
      return;
    }
    this.props.onSetUrl?.(targetUrl);
    this.addToHistory('url', targetUrl);
    // Navigate the webview DIRECTLY too — clicking a URL-picker history row only
    // went through the redux/prop round-trip, which could be a no-op (the src
    // didn't always change), so the click appeared to do nothing.
    if (!targetUrl.startsWith('ai://')) {
      try {
        const wv: any = this.webviewRef.current;
        if (wv && typeof wv.loadURL === 'function') {
          void wv.loadURL(/^[a-z]+:\/\//i.test(targetUrl) ? targetUrl : 'https://' + targetUrl);
        }
      } catch {
        /* webview not ready */
      }
    }
  };

  runAiChat = async (conversationId: string, userText: string) => {
    if (!userText.trim()) return;

    let activeConv = this.state.aiConversations.find((c) => c.id === conversationId);
    if (!activeConv) {
      activeConv = {
        id: conversationId,
        title: userText.trim().substring(0, 40),
        messages: []
      };
    }

    const updatedMessages = [
      ...activeConv.messages,
      {role: 'user' as const, content: userText.trim(), timestamp: Date.now()}
    ];

    const updatedConv = {
      ...activeConv,
      messages: updatedMessages
    };

    const updatedConvs = this.state.aiConversations.some((c) => c.id === conversationId)
      ? this.state.aiConversations.map((c) => (c.id === conversationId ? updatedConv : c))
      : [updatedConv, ...this.state.aiConversations];

    this.setState({
      aiConversations: updatedConvs,
      aiInputVal: '',
      aiStreamingMessage: '',
      searchState: 'searching',
      searchLogs: [],
      searchStats: null,
      searchError: null
    });

    try {
      localStorage.setItem('web_pane_ai_conversations', JSON.stringify(updatedConvs));
    } catch (e) {
      console.error('Failed to save conversation:', e);
    }

    this.addToHistory('ai-query', userText.trim(), {conversationId});

    const port = process.env.HYPERIA_PORT || '9800';
    const baseUrl = `http://localhost:${port}`;
    this.searchAbortCtrl = new AbortController();

    try {
      const response = await fetch(`${baseUrl}/api/ghost/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({message: userText.trim()}),
        signal: this.searchAbortCtrl.signal
      });

      if (!response.ok) {
        throw new Error(`Sidecar returned HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Response body is empty');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;

          try {
            const ev = JSON.parse(dataStr);
            if (ev.type === 'text_delta') {
              this.setState((state) => ({
                aiStreamingMessage: state.aiStreamingMessage + (ev.text || '')
              }));
            } else if (ev.type === 'tool_start') {
              this.setState((state) => {
                const exists = state.searchLogs.some((l) => l.id === ev.id);
                if (exists) return null;
                return {
                  searchLogs: [...state.searchLogs, {id: ev.id, name: ev.name, status: 'running', expanded: false}]
                };
              });
            } else if (ev.type === 'tool_result') {
              this.setState((state) => {
                const isErr = /error|failed|blocked/i.test((ev.output as string) || '');
                return {
                  searchLogs: state.searchLogs.map((l) =>
                    l.id === ev.id
                      ? {
                          ...l,
                          input: ev.input,
                          output: ev.output || '(no output)',
                          status: (isErr ? 'fail' : 'ok') as 'ok' | 'fail'
                        }
                      : l
                  )
                };
              });
            } else if (ev.type === 'stats') {
              this.setState({searchStats: ev.stats});
            } else if (ev.type === 'error') {
              this.setState({searchError: ev.error || 'Unknown error'});
            }
          } catch (err) {
            console.warn('[AI Stream] JSON parse error:', err, dataStr);
          }
        }
      }

      this.setState((state) => {
        const finalAssistantText = state.aiStreamingMessage;
        const conv = state.aiConversations.find((c) => c.id === conversationId);
        if (!conv) return null;

        const newMessages = [
          ...conv.messages,
          {role: 'assistant' as const, content: finalAssistantText, timestamp: Date.now()}
        ];

        const nextConv = {...conv, messages: newMessages};
        const nextConvs = state.aiConversations.map((c) => (c.id === conversationId ? nextConv : c));

        try {
          localStorage.setItem('web_pane_ai_conversations', JSON.stringify(nextConvs));
        } catch (e) {
          console.error(e);
        }

        return {
          aiConversations: nextConvs,
          aiStreamingMessage: '',
          searchState: 'completed'
        };
      });
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('AI chat failed:', err);
        this.setState({
          searchState: 'error',
          searchError: err.message || String(err)
        });
      }
    } finally {
      this.searchAbortCtrl = null;
    }
  };

  checkAndTriggerInitialAiChat = () => {
    const {url} = this.props;
    if (url && url.startsWith('ai://')) {
      const conversationId = url.slice(5);
      const conv = this.state.aiConversations.find((c) => c.id === conversationId);
      if (conv && conv.messages.length === 0 && this.state.searchState === 'idle') {
        void this.runAiChat(conversationId, conv.title);
      }
    }
  };

  runAgentSearch = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;

    if (isValidUrl(trimmed)) {
      let finalUrl = trimmed;
      if (!/^https?:\/\//i.test(finalUrl)) {
        if (/^(localhost|127\.0\.0\.1)/i.test(finalUrl)) {
          finalUrl = 'http://' + finalUrl;
        } else {
          finalUrl = 'https://' + finalUrl;
        }
      }
      this.navigateWebview(finalUrl);
      return;
    }

    this.stopAgentSearch();

    this.setState({
      searchQuery: trimmed,
      searchState: 'searching',
      searchText: '',
      searchLogs: [],
      searchStats: null,
      searchError: null
    });

    const port = process.env.HYPERIA_PORT || '9800';
    const baseUrl = `http://localhost:${port}`;
    this.searchAbortCtrl = new AbortController();

    try {
      const response = await fetch(`${baseUrl}/api/ghost/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({message: trimmed}),
        signal: this.searchAbortCtrl.signal
      });

      if (!response.ok) {
        throw new Error(`Sidecar returned HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Response body is empty');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;

          try {
            const ev = JSON.parse(dataStr);
            this.handleAgentSearchEvent(ev);
          } catch (err) {
            console.warn('[Search SSE] JSON parse error:', err, dataStr);
          }
        }
      }

      this.setState((state) => {
        if (state.searchState === 'searching') {
          return {searchState: 'completed'};
        }
        return null;
      });
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('Search query failed:', err);
        this.setState({
          searchState: 'error',
          searchError: err.message || String(err)
        });
      }
    } finally {
      this.searchAbortCtrl = null;
    }
  };

  handleAgentSearchEvent = (ev: any) => {
    switch (ev.type) {
      case 'text_delta':
        this.setState((state) => ({
          searchText: state.searchText + (ev.text || '')
        }));
        break;

      case 'tool_start':
        this.setState((state) => {
          const exists = state.searchLogs.some((log) => log.id === ev.id);
          if (exists) return null;
          return {
            searchLogs: [
              ...state.searchLogs,
              {
                id: ev.id,
                name: ev.name,
                status: 'running',
                expanded: false
              }
            ]
          };
        });
        break;

      case 'tool_result':
        this.setState((state) => {
          const isErr = /error|failed|blocked|unknown tool/i.test((ev.output as string) || '');
          const updatedLogs = state.searchLogs.map((log) => {
            if (log.id === ev.id) {
              return {
                ...log,
                input: ev.input,
                output: ev.output || '(no output)',
                status: (isErr ? 'fail' : 'ok') as 'ok' | 'fail'
              };
            }
            return log;
          });
          const exists = state.searchLogs.some((log) => log.id === ev.id);
          if (!exists) {
            updatedLogs.push({
              id: ev.id,
              name: ev.name,
              input: ev.input,
              output: ev.output || '(no output)',
              status: (isErr ? 'fail' : 'ok') as 'ok' | 'fail',
              expanded: false
            });
          }
          return {searchLogs: updatedLogs};
        });
        break;

      case 'stats':
        this.setState({
          searchStats: {
            inputTokens: ev.input_tokens || 0,
            outputTokens: ev.output_tokens || 0,
            toolCalls: ev.tool_calls || 0,
            turns: ev.turns || 0
          }
        });
        break;

      case 'done':
        this.setState({
          searchState: 'completed'
        });
        break;

      case 'error':
        this.setState({
          searchState: 'error',
          searchError: ev.message || 'Unknown error occurred'
        });
        break;

      default:
        break;
    }
  };

  stopAgentSearch = () => {
    if (this.searchAbortCtrl) {
      this.searchAbortCtrl.abort();
      this.searchAbortCtrl = null;
    }
    this.setState({
      searchState: 'idle'
    });
    const port = process.env.HYPERIA_PORT || '9800';
    fetch(`http://localhost:${port}/api/ghost/stop`, {
      method: 'POST'
    }).catch((err) => console.warn('Failed to stop agent execution:', err));
  };

  toggleSaveHistory = () => {
    const nextVal = !this.state.saveHistory;
    this.setState({saveHistory: nextVal});
    try {
      localStorage.setItem('web_pane_save_history', String(nextVal));
    } catch (err) {
      console.error('Failed to save saveHistory option:', err);
    }
  };

  addToHistory = (kind: 'url' | 'ai-query', value: string, extra: Partial<WebHistoryEntry> = {}) => {
    if (!this.state.saveHistory) {
      return;
    }
    const newEntry: WebHistoryEntry = {
      kind,
      value,
      visitedAt: Date.now(),
      ...extra
    };

    if (kind === 'url') {
      newEntry.securityState = getSecurityState(value);
    }

    // De-dupe on a NORMALIZED key so "x.com" and "x.com/" don't both linger.
    const key = kind === 'url' ? normalizeUrlKey(value) : value;
    const filtered = this.state.webHistory.filter((item) => {
      if (item.kind !== kind) return true;
      const itemKey = kind === 'url' ? normalizeUrlKey(item.value) : item.value;
      return itemKey !== key;
    });
    const newHistory = [newEntry, ...filtered].slice(0, 200);

    this.setState({
      webHistory: newHistory
    });

    try {
      localStorage.setItem('web_pane_history', JSON.stringify(newHistory));
      localStorage.setItem(`web_pane_history_${this.props.groupUid}`, JSON.stringify(newHistory));
    } catch (err) {
      console.error('Failed to persist web pane history:', err);
    }
  };

  removeHistoryEntry = (kind: 'url' | 'ai-query', value: string, visitedAt?: number) => {
    const normKey = kind === 'url' ? normalizeUrlKey(value) : value;
    const newHistory = this.state.webHistory.filter((item) => {
      if (item.kind === kind) {
        const itemKey = kind === 'url' ? normalizeUrlKey(item.value) : item.value;
        if (itemKey === normKey) {
          if (visitedAt === undefined || item.visitedAt === visitedAt) {
            return false;
          }
        }
      }
      return true;
    });

    this.setState({
      webHistory: newHistory
    });

    try {
      localStorage.setItem('web_pane_history', JSON.stringify(newHistory));
      localStorage.setItem(`web_pane_history_${this.props.groupUid}`, JSON.stringify(newHistory));
    } catch (err) {
      console.error('Failed to persist web pane history:', err);
    }
  };

  clearAllHistory = () => {
    this.setState({
      webHistory: []
    });

    try {
      localStorage.removeItem('web_pane_history');
      localStorage.removeItem(`web_pane_history_${this.props.groupUid}`);
    } catch (err) {
      console.error('Failed to clear web pane history:', err);
    }
  };

  removeAiConversation = (id: string) => {
    const newConvs = this.state.aiConversations.filter((c) => c.id !== id);
    this.setState({
      aiConversations: newConvs
    });

    try {
      localStorage.setItem('web_pane_ai_conversations', JSON.stringify(newConvs));
    } catch (err) {
      console.error('Failed to persist AI conversations:', err);
    }
  };

  clearAllAiConversations = () => {
    this.setState({
      aiConversations: []
    });

    try {
      localStorage.removeItem('web_pane_ai_conversations');
    } catch (err) {
      console.error('Failed to clear AI conversations:', err);
    }
  };

  handleOutsideClick = (e: MouseEvent) => {
    if (this.labelRef.current && !this.labelRef.current.contains(e.target as Node)) {
      this.setState({isEditingUrl: false});
    }

    // Click anywhere outside the dropdown and the URL bar → close it. (Clicks
    // INSIDE the guest <webview> don't reach this document, so those are handled
    // separately by the guest 'focus' listener in dom-ready.)
    if (
      this.state.isUrlNavigatorOpen &&
      this.urlNavigatorRef.current &&
      !this.urlNavigatorRef.current.contains(e.target as Node) &&
      this.urlBarRef.current &&
      !this.urlBarRef.current.contains(e.target as Node)
    ) {
      this.setState({isUrlNavigatorOpen: false});
    }
  };

  createConversation = (conversationId: string, initialQuery: string) => {
    const newConv = {
      id: conversationId,
      title: initialQuery.trim().substring(0, 40),
      messages: []
    };
    const updatedConvs = [newConv, ...this.state.aiConversations];
    this.setState({
      aiConversations: updatedConvs
    });
    try {
      localStorage.setItem('web_pane_ai_conversations', JSON.stringify(updatedConvs));
    } catch (e) {
      console.error('Failed to save conversation:', e);
    }
  };

  componentDidUpdate(prevProps: WebPaneProps, prevState: any) {
    if (this.props.url !== prevProps.url) {
      const newUrl = this.props.url || '';
      let {paneHistory, paneHistoryIndex} = this.state;
      const currentInHistory = paneHistory[paneHistoryIndex];

      if (newUrl && newUrl !== currentInHistory) {
        const foundIndex = paneHistory.indexOf(newUrl);
        if (foundIndex !== -1 && (foundIndex === paneHistoryIndex - 1 || foundIndex === paneHistoryIndex + 1)) {
          paneHistoryIndex = foundIndex;
        } else {
          const truncated = paneHistory.slice(0, paneHistoryIndex + 1);
          paneHistory = [...truncated, newUrl];
          paneHistoryIndex = paneHistory.length - 1;
        }
      }

      const isAi = newUrl.startsWith('ai://');
      this.setState(
        {
          activeUrl: newUrl,
          urlInputVal: newUrl,
          paneHistory,
          paneHistoryIndex,
          canGoBack: isAi ? paneHistoryIndex > 0 : this.state.canGoBack,
          canGoForward: isAi ? paneHistoryIndex < paneHistory.length - 1 : this.state.canGoForward
        },
        () => {
          this.checkAndTriggerInitialAiChat();
        }
      );
    }

    const wasActive = prevState.isEditingUrl || prevState.isUrlNavigatorOpen;
    const isActive = this.state.isEditingUrl || this.state.isUrlNavigatorOpen;

    if (isActive && !wasActive) {
      document.addEventListener('mousedown', this.handleOutsideClick);
    } else if (!isActive && wasActive) {
      document.removeEventListener('mousedown', this.handleOutsideClick);
    }
  }

  componentDidMount() {
    if (this.webWrapperRef.current) {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          const width = Math.round(entry.contentRect.width);
          // isNarrow gates split actions (keyboard + menu); it matches the width
          // where the toolbar hides the split buttons (hideSplits in render), so
          // you can't split via shortcut when the bar has no split buttons.
          const isNarrow = width < 400;
          if (isNarrow !== this.state.isNarrow || width !== this.state.paneWidth) {
            this.setState({isNarrow, paneWidth: width});
          }
        }
      });
      this.resizeObserver.observe(this.webWrapperRef.current);
    }

    // Check if AI is configured
    try {
      /* eslint-disable @typescript-eslint/no-unsafe-call */
      ipcRenderer
        .invoke('has-agent-token')
        .then((configured: boolean) => {
          this.setState({hasAiConfigured: !!configured});
        })
        .catch((err: any) => {
          console.warn('Failed to check AI config:', err);
        });
      /* eslint-enable @typescript-eslint/no-unsafe-call */
    } catch (err) {
      console.warn('IPC invoke error for has-agent-token:', err);
    }

    if (!this.webviewRef.current) return;
    const wv = this.webviewRef.current;

    // Belt-and-suspenders: ensure the guest can request popups so the main
    // process window-open handler fires for target="_blank" (→ split + open).
    try {
      wv.setAttribute('allowpopups', 'true');
    } catch {
      /* webview not ready */
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    wv.addEventListener('did-start-loading', () => {
      this.setState({loading: true, error: null, httpStatus: null, pageBgColor: null});
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    wv.addEventListener('did-stop-loading', async () => {
      this.setState({loading: false});
      this.updateNavigationState();
      try {
        const color = await wv.executeJavaScript(
          "(function(){try{var pick=function(el){if(!el)return '';var c=getComputedStyle(el).backgroundColor;return (c&&c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')?c:'';};return pick(document.body)||pick(document.documentElement)||'#ffffff';}catch(e){return '';}})()"
        );
        if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
          this.setState({pageBgColor: color});
        }
      } catch (err) {
        console.warn('Failed to retrieve page background color:', err);
      }

      // Check HTTP response status code for 404 or other bad status codes
      try {
        const httpStatus = await wv.executeJavaScript(
          "(function(){try{var entries=performance.getEntriesByType('navigation');return entries.length?entries[0].responseStatus:0;}catch(e){return 0;}})()"
        );
        if (httpStatus === 404 || httpStatus >= 400) {
          // Surface the bad status in the pane label ("404") instead of falling
          // back to a meaningless split letter.
          this.setState({httpStatus});
          const currentUrl = wv.getURL();
          if (currentUrl) {
            this.removeHistoryEntry('url', currentUrl);
          }
        }
      } catch (err) {
        console.warn('Failed to retrieve page HTTP status code:', err);
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    wv.addEventListener(
      'did-fail-load',
      (e: {errorCode: number; errorDescription: string; validatedURL?: string; isMainFrame?: boolean}) => {
        if (e.errorCode === -3) return;
        this.setState({loading: false, error: e.errorDescription || 'Failed to load'});
        const badUrl = e.validatedURL || this.state.urlInputVal;
        if (badUrl) {
          this.removeHistoryEntry('url', badUrl);
        }
        // A main-frame URL that didn't resolve (e.g. a typo'd domain like
        // news.hackernews.com) → fall back to a DuckDuckGo search of it. Guard
        // against looping if the DDG search itself fails.
        if (
          (e.isMainFrame ?? true) &&
          DDG_RESOLVE_FAIL.has(e.errorCode) &&
          badUrl &&
          !/duckduckgo\.com\/\?q=/i.test(badUrl)
        ) {
          const q = badUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
          this.navigateWebview('https://duckduckgo.com/?q=' + encodeURIComponent(q));
        }
      }
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    wv.addEventListener('page-title-updated', (e: {title?: string}) => {
      const title = e.title || '';
      if (title && this.props.onSetTitle) {
        this.props.onSetTitle(title);
      }
    });

    // Listen for did-navigate and did-navigate-in-page to update active URL and history statuses
    const handleNavigation = (e: any) => {
      const url = (e.url as string) || '';
      this.setState({
        activeUrl: url,
        urlInputVal: url
      });
      this.updateNavigationState();

      if (url && url !== 'about:blank') {
        this.addToHistory('url', url);
        // Persist the LIVE url into the group's redux webUrl so it survives a
        // remount. Closing a SIBLING pane collapses the BSP tree and reparents
        // this pane, which unmounts+remounts the <webview>; without this the
        // remount reloads the ORIGINAL props.url and the pane jumps back to its
        // first page (#92). Guard on a real change so did-navigate-in-page spam
        // (SPA hash churn) doesn't thrash redux.
        if (url !== this.props.url) {
          this.props.onSetUrl?.(url);
        }
      }
    };

    /* eslint-disable @typescript-eslint/no-unsafe-call */
    wv.addEventListener('did-navigate', handleNavigation);
    wv.addEventListener('did-navigate-in-page', handleNavigation);

    // Find-in-page match counts come back here.
    wv.addEventListener('found-in-page', (e: any) => {
      const r = e?.result || {};
      this.setState({
        findActive: typeof r.activeMatchOrdinal === 'number' ? r.activeMatchOrdinal : 0,
        findTotal: typeof r.matches === 'number' ? r.matches : 0
      });
    });

    wv.addEventListener('dom-ready', () => {
      this.updateNavigationState();
      // Slim scrollbars — but only as a DEFAULT the page can override. We prepend
      // a <style> at the very top of <head> so any scrollbar rules the page ships
      // (later in the cascade) win; pages that DON'T style their scrollbars get
      // our slim ones instead of Chromium's chunky default.
      try {
        void wv.executeJavaScript(
          "(function(){try{var ID='__hyperia_slim_sb__';if(document.getElementById(ID))return;" +
            "var s=document.createElement('style');s.id=ID;" +
            "s.textContent='::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(128,128,128,.45);border-radius:6px}::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.7)}';" +
            'var h=document.head||document.documentElement;h.insertBefore(s,h.firstChild);}catch(e){}})()'
        );
      } catch {
        /* webview not ready */
      }
      try {
        // <webview>.getWebContents() was REMOVED in modern Electron (that's why the
        // right-click menu + link handlers silently never attached). Resolve the
        // guest webContents via its id through @electron/remote instead.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const remote = require('@electron/remote');
        const wc = remote.webContents.fromId(wv.getWebContentsId());
        if (wc) {
          wc.removeAllListeners('before-input-event');
          wc.on('before-input-event', (event: any, input: any) => {
            if (input.type === 'keyDown') {
              const isPlus = input.key === '=' || input.key === '+';
              const isMinus = input.key === '-';
              const isZero = input.key === '0';

              // Ctrl/Cmd+F → open the find bar (the guest has focus, so this is
              // the only place the keystroke is observable).
              if ((input.control || input.meta) && input.key.toLowerCase() === 'f') {
                event.preventDefault();
                this.openFind();
                return;
              }
              // Esc closes the find bar if it's open.
              if (input.key === 'Escape' && this.state.findOpen) {
                event.preventDefault();
                this.closeFind();
                return;
              }

              if ((input.control || input.meta) && isPlus) {
                event.preventDefault();
                try {
                  const currentZoom = wv.getZoomFactor();
                  wv.setZoomFactor(Math.min(currentZoom + 0.1, 3.0));
                } catch (err) {
                  console.error('Failed to zoom in:', err);
                }
              } else if ((input.control || input.meta) && isMinus) {
                event.preventDefault();
                try {
                  const currentZoom = wv.getZoomFactor();
                  wv.setZoomFactor(Math.max(currentZoom - 0.1, 0.5));
                } catch (err) {
                  console.error('Failed to zoom out:', err);
                }
              } else if ((input.control || input.meta) && isZero) {
                event.preventDefault();
                try {
                  wv.setZoomFactor(1.0);
                } catch (err) {
                  console.error('Failed to reset zoom:', err);
                }
              }

              const keyLower = input.key.toLowerCase();

              // Ctrl+Shift+D / Ctrl+Shift+| -> Split Right (vertical split)
              if ((input.control || input.meta) && input.shift && (keyLower === 'd' || input.key === '|')) {
                event.preventDefault();
                rpc.emit('split request vertical', {activeUid: this.props.sessionUid || this.props.groupUid});
                return;
              }

              // Ctrl+Shift+_ / Ctrl+Shift+- -> Split Down (horizontal split)
              if ((input.control || input.meta) && input.shift && (input.key === '_' || input.key === '-')) {
                event.preventDefault();
                rpc.emit('split request horizontal', {activeUid: this.props.sessionUid || this.props.groupUid});
                return;
              }

              // Ctrl+Alt+Shift+D / Ctrl+Alt+Shift+| -> Clone Right
              if (
                (input.control || input.meta) &&
                input.alt &&
                input.shift &&
                (keyLower === 'd' || input.key === '|')
              ) {
                event.preventDefault();
                this.props.onSplitWebPane?.(this.state.activeUrl || this.props.url || '', 'VERTICAL');
                return;
              }

              // Ctrl+Alt+Shift+_ / Ctrl+Alt+Shift+- -> Clone Down
              if (
                (input.control || input.meta) &&
                input.alt &&
                input.shift &&
                (input.key === '_' || input.key === '-')
              ) {
                event.preventDefault();
                this.props.onSplitWebPane?.(this.state.activeUrl || this.props.url || '', 'HORIZONTAL');
                return;
              }

              // Ctrl+Shift+W -> Close Pane
              if ((input.control || input.meta) && input.shift && keyLower === 'w') {
                event.preventDefault();
                if (this.props.hasSession) {
                  this.props.onClose?.();
                } else {
                  (this.props as any).onClosePane();
                }
                return;
              }

              // Ctrl+Shift+T -> new tab/term group
              if ((input.control || input.meta) && input.shift && keyLower === 't') {
                event.preventDefault();
                (rpc.emitter.emit as any)('termgroup add req', {
                  activeUid: this.props.sessionUid || this.props.groupUid
                });
                return;
              }

              // Ctrl+Tab -> Next tab
              if ((input.control || input.meta) && !input.shift && input.key === 'Tab') {
                event.preventDefault();
                (rpc.emitter.emit as any)('move right req');
                return;
              }

              // Ctrl+Shift+Tab -> Prev tab
              if ((input.control || input.meta) && input.shift && input.key === 'Tab') {
                event.preventDefault();
                (rpc.emitter.emit as any)('move left req');
                return;
              }

              // Ctrl+1 through Ctrl+9 -> Jump to tab index
              if ((input.control || input.meta) && /^[1-9]$/.test(input.key)) {
                event.preventDefault();
                const index = parseInt(input.key, 10) - 1;
                (rpc.emitter.emit as any)('move jump req', index);
                return;
              }
            }
          });

          // NOTE: the right-click menu is built in the MAIN process via
          // window.webContents 'did-attach-webview' → guest 'context-menu'
          // (app/ui/window.ts). Registering a second context-menu handler here
          // popped a competing menu, so the renderer path is intentionally gone.

          // dom-ready fires on EVERY page load and re-runs this block on the same
          // (stable-id) guest webContents, so without removing first these
          // listeners accumulate — N copies of will-navigate → N browser tabs
          // opened for one OAuth redirect. Clear before re-adding.
          wc.removeAllListeners('focus');
          wc.removeAllListeners('will-navigate');
          wc.removeAllListeners('will-redirect');

          // Clicking into the guest page focuses its webContents but never fires
          // a mousedown in THIS document — so the outside-click handler can't see
          // it. Close the URL navigator and activate this pane when the page takes focus.
          wc.on('focus', () => {
            if (this.state.isUrlNavigatorOpen) {
              this.setState({isUrlNavigatorOpen: false});
            }
            this.props.onActive?.();
          });

          wc.on('will-navigate', (event: any, url: string) => {
            if (isOAuthUrl(url)) {
              event.preventDefault();
              this.openOAuthExternal(url);
            }
          });

          wc.on('will-redirect', (event: any, url: string) => {
            if (isOAuthUrl(url)) {
              event.preventDefault();
              this.openOAuthExternal(url);
            }
          });
        }
      } catch (err) {
        console.warn('Failed to access webContents for zoom/contextmenu:', err);
      }

      // Retrieve page background color on dom-ready as well
      try {
        wv.executeJavaScript(
          "(function(){try{var pick=function(el){if(!el)return '';var c=getComputedStyle(el).backgroundColor;return (c&&c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')?c:'';};return pick(document.body)||pick(document.documentElement)||'#ffffff';}catch(e){return '';}})()"
        )
          .then((color: string) => {
            if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
              this.setState({pageBgColor: color});
            }
          })
          .catch(() => {});
      } catch (err) {
        // ignore
      }
    });

    // OAuth bail-out. Google (and a few others) refuse to sign users in from
    // embedded browsers — per RFC 8252 native apps "should not" embed a user
    // agent for OAuth. So any nav targeting a known OAuth host gets handed to
    // the system browser instead. The webview stays put; the user completes
    // sign-in externally. Hyperia is a terminal, not a Gmail client.
    // Same-frame redirect → stop, hand to system browser.
    wv.addEventListener('will-navigate', (e: any) => {
      const url = (e?.url as string) || '';
      if (isOAuthUrl(url)) {
        try {
          wv.stop();
        } catch {
          /* ignore — webview may not be ready */
        }
        void shell.openExternal(url);
      }
    });
    // Popup (e.g. clicking "Sign in with Google" usually opens a new window).
    wv.addEventListener('new-window', (e: any) => {
      const url = (e?.url as string) || '';
      if (isOAuthUrl(url)) {
        e.preventDefault?.();
        void shell.openExternal(url);
      }
    });
    /* eslint-enable @typescript-eslint/no-unsafe-call */

    // Listen for Ctrl+L shortcut
    this._windowKeydownHandler = (e: KeyboardEvent) => {
      // Esc closes the URL navigator even when focus has left the input (e.g.
      // the user tabbed/clicked away but the dropdown is still up).
      if (e.key === 'Escape' && this.state.isUrlNavigatorOpen) {
        e.preventDefault();
        e.stopPropagation();
        this.setState({isUrlNavigatorOpen: false});
        return;
      }
      // Ctrl/Cmd+F → find-in-page (when the toolbar/chrome has focus; the guest
      // page is handled separately via before-input-event).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        this.openFind();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        e.stopPropagation();
        this.setState(
          {
            isUrlNavigatorOpen: true,
            navigatorInputVal: '',
            navigatorFocusedIndex: -1,
            navigatorError: null
          },
          () => {
            requestAnimationFrame(() => {
              if (this.navigatorInputRef.current) {
                this.navigatorInputRef.current.focus();
                this.navigatorInputRef.current.select();
              }
            });
          }
        );
      }
    };
    window.addEventListener('keydown', this._windowKeydownHandler);
    window.addEventListener('resize', this.onWindowResize);

    // Listen for reload requests from the tab right-click menu
    this._reloadHandler = (uid: string) => {
      if (uid === this.props.groupUid && this.webviewRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        this.webviewRef.current.reload();
      }
    };
    rpc.on('web-pane-reload', this._reloadHandler);

    // Right-click → "Find in page" (main process sends the guest's webContents
    // id; only the matching pane opens its find bar).
    this._findHandler = (_e: any, guestId: number) => {
      try {
        if (this.webviewRef.current && this.webviewRef.current.getWebContentsId() === guestId) {
          this.openFind();
        }
      } catch {
        /* webview not ready */
      }
    };
    ipcRenderer.on('web-pane-find', this._findHandler);

    // target="_blank" / window.open from the guest → split DOWN and open the
    // link in a new web pane below this one (we have panes, not browser tabs).
    this._openSplitHandler = (_e: any, guestId: number, url: string) => {
      try {
        if (this.webviewRef.current && this.webviewRef.current.getWebContentsId() === guestId) {
          // Dedicated web-split: makes a clean web pane below (no shell/session),
          // not the terminal-split path that dragged a phantom shell pane along.
          rpc.emit('split web pane req', {
            activeUid: this.props.sessionUid || this.props.groupUid,
            url
          });
        }
      } catch (err) {
        console.error('web-pane-open-split failed:', err);
      }
    };
    ipcRenderer.on('web-pane-open-split', this._openSplitHandler);

    this._clickHandler = (data: {uid: string; text?: string; selector?: string}) => {
      if (data.uid === this.props.groupUid && this.webviewRef.current) {
        const wv = this.webviewRef.current;
        if (data.selector) {
          const code = `
            (() => {
              const el = document.querySelector(${JSON.stringify(data.selector)});
              if (el) {
                function triggerMouseEvent(node, eventType) {
                  const clickEvent = new MouseEvent(eventType, {
                    bubbles: true,
                    cancelable: true,
                    view: window
                  });
                  node.dispatchEvent(clickEvent);
                }
                try { el.focus(); } catch(e){}
                triggerMouseEvent(el, 'mouseover');
                triggerMouseEvent(el, 'mousedown');
                triggerMouseEvent(el, 'click');
                triggerMouseEvent(el, 'mouseup');
                if (typeof el.click === 'function') el.click();
                return { success: true };
              }
              return { success: false, error: 'Selector not found' };
            })()
          `;
          wv.executeJavaScript(code)
            .then((result: any) => {
              rpc.emit('web-pane-click-result', {uid: data.uid, result});
            })
            .catch((err: any) => {
              rpc.emit('web-pane-click-result', {uid: data.uid, result: {success: false, error: err.message}});
            });
        } else if (data.text) {
          const code = `
            (${clickFnStr})(${JSON.stringify(data.text)})
          `;
          wv.executeJavaScript(code)
            .then((result: any) => {
              rpc.emit('web-pane-click-result', {uid: data.uid, result});
            })
            .catch((err: any) => {
              rpc.emit('web-pane-click-result', {uid: data.uid, result: {success: false, error: err.message}});
            });
        }
      }
    };
    rpc.on('web-pane-click', this._clickHandler);

    // Read the CURRENT page: live URL + title + visible text. Lets the agent
    // see what page the user actually navigated to (the opened URL goes stale)
    // and extract its content without re-fetching.
    this._readHandler = (data: {uid: string}) => {
      if (data.uid === this.props.groupUid && this.webviewRef.current) {
        const wv = this.webviewRef.current;
        const code = `
          (() => {
            try {
              return {
                success: true,
                url: location.href,
                title: document.title,
                // The RENDERED DOM (post-JS, authed). The sidecar runs grub_md on
                // this to produce clean reader-mode markdown — no external re-fetch.
                html: (document.documentElement ? document.documentElement.outerHTML : '').slice(0, 3000000)
              };
            } catch (e) { return { success: false, error: String(e) }; }
          })()
        `;
        wv.executeJavaScript(code)
          .then((result: any) => {
            rpc.emit('web-pane-read-result', {uid: data.uid, result});
          })
          .catch((err: any) => {
            rpc.emit('web-pane-read-result', {uid: data.uid, result: {success: false, error: err.message}});
          });
      }
    };
    rpc.on('web-pane-read', this._readHandler);

    // Inject + run arbitrary JS in the page, return its (serializable) value.
    this._evalHandler = (data: {uid: string; js: string}) => {
      if (data.uid === this.props.groupUid && this.webviewRef.current) {
        const wv = this.webviewRef.current;
        // userGesture=true so gesture-gated APIs (focus, play, clipboard) work.
        wv.executeJavaScript(data.js, true)
          .then((value: any) => {
            rpc.emit('web-pane-eval-result', {uid: data.uid, result: {success: true, value}});
          })
          .catch((err: any) => {
            rpc.emit('web-pane-eval-result', {uid: data.uid, result: {success: false, error: err.message}});
          });
      }
    };
    rpc.on('web-pane-eval', this._evalHandler);

    // Move / click at a pixel coordinate, with the 👻 ghost cursor gliding there
    // so the human can watch the agent act on the page.
    this._mouseHandler = (data: {uid: string; x: number; y: number; action?: string}) => {
      if (data.uid === this.props.groupUid && this.webviewRef.current) {
        const wv = this.webviewRef.current;
        const x = Number(data.x) || 0;
        const y = Number(data.y) || 0;
        const action = data.action === 'click' ? 'click' : 'move';
        const code = `(${ghostMouseFnStr})(${x}, ${y}, ${JSON.stringify(action)})`;
        wv.executeJavaScript(code)
          .then((result: any) => {
            rpc.emit('web-pane-mouse-result', {uid: data.uid, result});
          })
          .catch((err: any) => {
            rpc.emit('web-pane-mouse-result', {uid: data.uid, result: {success: false, error: err.message}});
          });
      }
    };
    rpc.on('web-pane-mouse', this._mouseHandler);

    rpc.on('web-pane-zoom-in', this.handleZoomIn);
    rpc.on('web-pane-zoom-out', this.handleZoomOut);
    rpc.on('web-pane-zoom-reset', this.handleZoomReset);

    this.checkAndTriggerInitialAiChat();
  }

  componentWillUnmount() {
    rpc.removeListener('web-pane-zoom-in', this.handleZoomIn);
    rpc.removeListener('web-pane-zoom-out', this.handleZoomOut);
    rpc.removeListener('web-pane-zoom-reset', this.handleZoomReset);

    this.resizeObserver?.disconnect();
    document.removeEventListener('mousedown', this.handleOutsideClick);
    if (this._windowKeydownHandler) {
      window.removeEventListener('keydown', this._windowKeydownHandler);
    }
    window.removeEventListener('resize', this.onWindowResize);
    if (this._findHandler) {
      ipcRenderer.removeListener('web-pane-find', this._findHandler);
    }
    if (this._openSplitHandler) {
      ipcRenderer.removeListener('web-pane-open-split', this._openSplitHandler);
    }
    if (this._reloadHandler) {
      rpc.removeListener('web-pane-reload', this._reloadHandler);
    }
    if (this._clickHandler) {
      rpc.removeListener('web-pane-click', this._clickHandler);
    }
    if (this._readHandler) {
      rpc.removeListener('web-pane-read', this._readHandler);
    }
    if (this._evalHandler) {
      rpc.removeListener('web-pane-eval', this._evalHandler);
    }
    if (this._mouseHandler) {
      rpc.removeListener('web-pane-mouse', this._mouseHandler);
    }
    // Return keyboard focus to the active terminal after the web pane is removed.
    // The webview captures focus while mounted; without this the xterm textarea
    // stays unfocused (hollow cursor, input goes nowhere).
    requestAnimationFrame(() => {
      if (typeof window.focusActiveTerm === 'function') {
        window.focusActiveTerm();
      } else {
        document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus();
      }
    });
  }

  onWindowResize = () => {
    if (this.state.isUrlNavigatorOpen) {
      this.setState({isUrlNavigatorOpen: false});
    }
  };

  handleZoomIn = (data: {uid: string}) => {
    if (data.uid !== this.props.groupUid) return;
    const wv = this.webviewRef.current;
    if (wv) {
      try {
        const currentZoom = wv.getZoomFactor();
        wv.setZoomFactor(Math.min(currentZoom + 0.1, 3.0));
      } catch (err) {
        console.error('Failed to zoom in:', err);
      }
    }
  };

  handleZoomOut = (data: {uid: string}) => {
    if (data.uid !== this.props.groupUid) return;
    const wv = this.webviewRef.current;
    if (wv) {
      try {
        const currentZoom = wv.getZoomFactor();
        wv.setZoomFactor(Math.max(currentZoom - 0.1, 0.5));
      } catch (err) {
        console.error('Failed to zoom out:', err);
      }
    }
  };

  handleZoomReset = (data: {uid: string}) => {
    if (data.uid !== this.props.groupUid) return;
    const wv = this.webviewRef.current;
    if (wv) {
      try {
        wv.setZoomFactor(1.0);
      } catch (err) {
        console.error('Failed to reset zoom:', err);
      }
    }
  };

  _reloadHandler: ((uid: string) => void) | null = null;
  _clickHandler: ((data: {uid: string; text?: string; selector?: string}) => void) | null = null;
  _readHandler: ((data: {uid: string}) => void) | null = null;
  _evalHandler: ((data: {uid: string; js: string}) => void) | null = null;
  _mouseHandler: ((data: {uid: string; x: number; y: number; action?: string}) => void) | null = null;

  // Hand an OAuth URL to the system browser, but only ONCE per flow. A single
  // sign-in bounces through many redirects (login → authorize → consent → …),
  // each matching isOAuthUrl; without this guard every hop opened a new tab.
  openOAuthExternal = (url: string): void => {
    const now = Date.now();
    if (now - this._lastOAuthOpenAt < 8000) return;
    this._lastOAuthOpenAt = now;
    void shell.openExternal(url);
  };

  // ── Find-in-page (Ctrl+F) ────────────────────────────────────────────────
  openFind = (): void => {
    this.setState({findOpen: true}, () => {
      const el = this.findInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
      // Re-run the search if there's already a query (re-opening).
      if (this.state.findText) this.doFind(this.state.findText, true);
    });
  };

  closeFind = (): void => {
    const wv: any = this.webviewRef.current;
    try {
      wv?.stopFindInPage?.('clearSelection');
    } catch {
      /* webview not ready */
    }
    this.setState({findOpen: false, findActive: 0, findTotal: 0});
  };

  doFind = (text: string, forward = true): void => {
    const wv: any = this.webviewRef.current;
    if (!wv) return;
    if (!text) {
      try {
        wv.stopFindInPage('clearSelection');
      } catch {
        /* ignore */
      }
      this.setState({findActive: 0, findTotal: 0});
      return;
    }
    try {
      // findNext:false starts a fresh search; the 'found-in-page' event updates
      // the match counts.
      wv.findInPage(text, {forward, findNext: false});
    } catch (err) {
      console.error('findInPage failed:', err);
    }
  };

  findStep = (forward: boolean): void => {
    const wv: any = this.webviewRef.current;
    const text = this.state.findText;
    if (!wv || !text) return;
    try {
      wv.findInPage(text, {forward, findNext: true});
    } catch (err) {
      console.error('findInPage step failed:', err);
    }
  };

  // Screenshot the rendered web pane. Uses the <webview>'s own capturePage()
  // (renderer-side, no right-click / no main-process round trip — works even on
  // pages that suppress the context menu). Copies the PNG to the clipboard and
  // saves a copy under ~/.hyperia/snapshots/. Brief icon flash as confirmation.
  captureScreenshot = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    const wv: any = this.webviewRef.current;
    if (!wv || typeof wv.capturePage !== 'function') return;
    const iconEl = (e.currentTarget as HTMLElement).querySelector('i');
    try {
      const img = await wv.capturePage();
      if (!img || img.isEmpty()) return;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {clipboard} = require('electron');
      clipboard.writeImage(img);
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const os = require('os');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        const dir = path.join(os.homedir(), '.hyperia', 'snapshots');
        fs.mkdirSync(dir, {recursive: true});
        let host = 'page';
        try {
          host = new URL(this.state.activeUrl || this.props.url || '').hostname || 'page';
        } catch {
          /* keep 'page' */
        }
        fs.writeFileSync(path.join(dir, `webshot-${host}-${Date.now()}.png`), img.toPNG());
      } catch (saveErr) {
        // clipboard copy already succeeded; disk save is best-effort
        console.error('[web-pane] screenshot save failed:', saveErr);
      }
      // Transient confirmation: swap the camera glyph to a check for ~1.4s.
      if (iconEl) {
        const prev = iconEl.className;
        iconEl.className = 'ti ti-check';
        setTimeout(() => {
          iconEl.className = prev;
        }, 1400);
      }
    } catch (err) {
      console.error('[web-pane] capturePage failed:', err);
    }
  };

  // Create a new sticky note from the current page: title + URL + the selected
  // text (or a trimmed extract of the main content). Sent to the main process,
  // which owns sticky windows.
  newStickyFromPage = (): void => {
    const wv: any = this.webviewRef.current;
    const fallbackTitle = (this.props as any).webName || this.state.activeUrl || this.props.url || 'Page';
    const fallbackUrl = this.state.activeUrl || this.props.url || '';
    const send = (text: string) => {
      try {
        ipcRenderer.send('new-sticky', {text});
      } catch (err) {
        console.error('new-sticky send failed:', err);
      }
    };
    if (!wv) {
      send(`# ${fallbackTitle}\n${fallbackUrl}`);
      return;
    }
    const js =
      '(() => { try {' +
      ' var sel = (window.getSelection && window.getSelection().toString().trim()) || "";' +
      ' var title = document.title || location.href;' +
      ' var url = location.href;' +
      ' var body = sel;' +
      ' if (!body) { var el = document.querySelector("article") || document.querySelector("main") || document.body;' +
      ' body = (el && el.innerText ? el.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, 4000); }' +
      ' return JSON.stringify({title: title, url: url, body: body});' +
      ' } catch (e) { return JSON.stringify({title: document.title || "", url: location.href, body: ""}); } })()';
    wv.executeJavaScript(js)
      .then((res: string) => {
        try {
          const {title, url, body} = JSON.parse(res);
          const text = `# ${title || fallbackTitle}\n${url || fallbackUrl}` + (body ? `\n\n${body}` : '');
          send(text);
        } catch {
          send(`# ${fallbackTitle}\n${fallbackUrl}`);
        }
      })
      .catch(() => send(`# ${fallbackTitle}\n${fallbackUrl}`));
  };

  handleContextMenu = (e: React.MouseEvent | any, params?: any, wc?: any) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
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
    // Inspect: dock DevTools at the bottom of THIS pane (splits down) and, when
    // we have the right-click coordinates, jump straight to that element.
    if (wc) {
      menu.append(new MenuItem({type: 'separator'}));
      menu.append(
        new MenuItem({
          label: 'Inspect',
          click: () => {
            try {
              if (!wc.isDevToolsOpened()) wc.openDevTools({mode: 'bottom'});
              if (params && typeof params.x === 'number') wc.inspectElement(params.x, params.y);
            } catch (err) {
              console.error('Inspect failed:', err);
            }
          }
        })
      );
    }
    menu.append(new MenuItem({type: 'separator'}));
    menu.append(new MenuItem({label: 'New Stickys', click: () => void ipcMain.emit('new-sticky', {})}));
    menu.append(new MenuItem({label: 'Search Stickys', click: () => void ipcMain.emit('search-stickies')}));
    menu.append(new MenuItem({type: 'separator'}));
    menu.append(new MenuItem({label: 'Close Tab', click: () => this.props.onClose?.()}));
    menu.popup();
    /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call */
  };

  handlePaneBandContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    this.props.onActive?.();

    let isSplitDownDisabled = false;
    const {groupUid, allTermGroups} = this.props as any;
    if (groupUid && allTermGroups) {
      const stacks = countPathHorizontalStacks(groupUid, allTermGroups);
      if (stacks >= 11) {
        isSplitDownDisabled = true;
      }
    }

    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call */
    const remote = require('@electron/remote');
    const {Menu, MenuItem} = remote;
    const menu = new Menu();

    menu.append(
      new MenuItem({
        label: 'Split Right',
        accelerator: 'Ctrl+Shift+|',
        registerAccelerator: false,
        enabled: !this.state.isNarrow,
        click: () => {
          rpc.emit('split request vertical', {
            activeUid: this.props.sessionUid || this.props.groupUid,
            profile: 'picker'
          });
        }
      })
    );

    menu.append(
      new MenuItem({
        label: 'Split Down',
        accelerator: 'Ctrl+Shift+_',
        registerAccelerator: false,
        enabled: !isSplitDownDisabled,
        click: () => {
          rpc.emit('split request horizontal', {activeUid: this.props.sessionUid || this.props.groupUid});
        }
      })
    );

    menu.append(
      new MenuItem({
        label: 'Clone Right',
        accelerator: 'Ctrl+Alt+Shift+|',
        registerAccelerator: false,
        enabled: !this.state.isNarrow,
        click: () => {
          this.props.onSplitWebPane?.(this.state.activeUrl || this.props.url || '', 'VERTICAL');
        }
      })
    );

    menu.append(
      new MenuItem({
        label: 'Clone Down',
        accelerator: 'Ctrl+Alt+Shift+_',
        registerAccelerator: false,
        enabled: !isSplitDownDisabled,
        click: () => {
          this.props.onSplitWebPane?.(this.state.activeUrl || this.props.url || '', 'HORIZONTAL');
        }
      })
    );

    menu.append(new MenuItem({type: 'separator'}));

    menu.append(
      new MenuItem({
        label: 'Rename Pane',
        click: () => {
          const val = prompt('Enter pane name:', ((this.props as any).webName as string) || 'Browser');
          if (val && (this.props as any).onSetTitle) {
            (this.props as any).onSetTitle(val.trim());
          }
        }
      })
    );

    menu.append(new MenuItem({type: 'separator'}));

    const termGroup = (this.props as any).allTermGroups?.[this.props.groupUid];
    const isPoppable = termGroup && !!termGroup.parentUid;

    if (isPoppable) {
      menu.append(
        new MenuItem({
          label: 'Move Pane to New Tab',
          click: () => {
            (this.props as any).onPopOutPane?.();
          }
        })
      );
    }

    menu.append(
      new MenuItem({
        label: 'Close Pane',
        accelerator: 'Ctrl+Shift+W',
        registerAccelerator: false,
        click: () => {
          if (this.props.hasSession) {
            this.props.onClose?.();
          } else {
            (this.props as any).onClosePane();
          }
        }
      })
    );

    menu.popup();
    /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call */
  };

  render() {
    let isSplitDownDisabled = false;
    const {groupUid, allTermGroups} = this.props as any;
    if (groupUid && allTermGroups) {
      const stacks = countPathHorizontalStacks(groupUid, allTermGroups);
      if (stacks >= 11) {
        isSplitDownDisabled = true;
      }
    }

    const {url, onClose, hasSession} = this.props;
    const {error, loading, httpStatus} = this.state;
    const splitLabel = (this.props as any).splitLabel;
    const showStrip = !!splitLabel || hasSession;
    const isAi = url && url.startsWith('ai://');
    const getStartIdx = (termGroups: Record<string, any>, groupUid: string): number => {
      let currentUid = groupUid;
      while (termGroups[currentUid]?.parentUid) {
        currentUid = termGroups[currentUid].parentUid;
      }
      const hashCode = (str: string): number => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        return Math.abs(hash);
      };
      return hashCode(currentUid) % 9;
    };

    const getPaneTint = (startIdx: number, splitLabel?: string): string => {
      const paneIdx = splitLabel ? splitLabel.charCodeAt(0) - 97 : 0; // 'a' -> 0, 'b' -> 1...
      const TINTS = ['success', 'info', 'warning', 'danger'];
      return TINTS[(startIdx + paneIdx) % TINTS.length];
    };

    const resolvedAllTermGroups = allTermGroups || {};
    const resolvedGroupUid = groupUid || '';
    const startIdx = getStartIdx(resolvedAllTermGroups, resolvedGroupUid);

    const tint = isAi ? 'ai' : getPaneTint(startIdx, splitLabel);
    // Cap the toolbar title — page titles run long ("… Recipe From Scratch -
    // Budget Bytes") and PaneBand renders nowrap + no-shrink, so the full title
    // spans the whole bar. Trim to a reasonable length with an ellipsis.
    const rawWebName = (this.props as any).webName as string | undefined;
    const webNameShort = rawWebName && rawWebName.length > 32 ? `${rawWebName.slice(0, 31).trimEnd()}…` : rawWebName;
    // Pane label priority — never the split letter ("Pane b"), which means
    // nothing to the user and confuses agents reading pane data. A bad load
    // shows its status ("404" / "Unreachable"), else the page title, else the
    // URL host, else a neutral "Browser".
    const hostLabel = (() => {
      try {
        return new URL(this.state.activeUrl || url || '').hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    const statusLabel = httpStatus && httpStatus >= 400 ? String(httpStatus) : error ? 'Unreachable' : '';
    const labelText = isAi ? 'ask' : statusLabel || webNameShort || hostLabel || 'Browser';

    // ── Toolbar collapse plan ────────────────────────────────────────────────
    // Priority, widest → narrowest:
    //   1. URL bar FILLS the row (grows), nav icons + title to its left, splits
    //      + close on the right.
    //   2. The moment the splits would crowd the URL bar's ~11-char floor, hide
    //      BOTH splits (no splitting a pane this small anyway) and give that
    //      space back to the URL bar.
    //   3. When even the floored URL bar can't fit, hide the URL bar entirely —
    //      end state is title + nav buttons + close. Never a sub-"https://" stub.
    // Nav buttons always stay (they're part of that end state). Thresholds are a
    // width budget (padding + title + nav + url-floor + splits + close), not
    // arbitrary — see numbers below.
    const w = this.state.paneWidth;
    const showBack = true;
    const showForward = true;
    const showReload = !isAi;
    const showExternal = !isAi;
    // splits (~60px) crowd the url floor below ~400; url floor (110) itself
    // stops fitting below ~320 → drop the bar.
    const hideSplits = w < 300;
    const showUrlBar = w >= 240;

    return (
      <div
        ref={this.webWrapperRef}
        className="web_fit"
        onKeyDown={this.handleKeyDown}
        onContextMenu={this.handleContextMenu}
        onMouseDown={(e) => {
          e.stopPropagation();
          this.props.onActive?.();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {showStrip && (
          <PaneBand
            ref={this.labelRef}
            paneType={isAi ? 'ai' : 'web'}
            paneId={this.props.groupUid}
            tint={tint as any}
            label={labelText}
            paneName={labelText}
            isSplitRightDisabled={hideSplits}
            isSplitDownDisabled={isSplitDownDisabled || hideSplits}
            navCluster={
              <div
                className="web-nav-cluster"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  flexShrink: 0
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {showBack && (
                  <span
                    className="term_controlIcon term_tooltipTrigger"
                    onClick={this.goBack}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      cursor: this.state.canGoBack ? 'pointer' : 'default',
                      opacity: this.state.canGoBack ? 1 : 0.4,
                      pointerEvents: this.state.canGoBack ? 'auto' : 'none'
                    }}
                  >
                    <i className="ti ti-arrow-left" style={{fontSize: '14px'}} aria-hidden="true" />
                    <div className="term_tooltip" style={{minWidth: '160px'}}>
                      <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>Back</div>
                      <div
                        style={{
                          fontSize: '11px',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-secondary)',
                          marginTop: 'var(--space-2)'
                        }}
                      >
                        Alt+Left
                      </div>
                    </div>
                  </span>
                )}
                {showForward && (
                  <span
                    className="term_controlIcon term_tooltipTrigger"
                    onClick={this.goForward}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      cursor: this.state.canGoForward ? 'pointer' : 'default',
                      opacity: this.state.canGoForward ? 1 : 0.4,
                      pointerEvents: this.state.canGoForward ? 'auto' : 'none'
                    }}
                  >
                    <i className="ti ti-arrow-right" style={{fontSize: '14px'}} aria-hidden="true" />
                    <div className="term_tooltip" style={{minWidth: '160px'}}>
                      <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>Forward</div>
                      <div
                        style={{
                          fontSize: '11px',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-secondary)',
                          marginTop: 'var(--space-2)'
                        }}
                      >
                        Alt+Right
                      </div>
                    </div>
                  </span>
                )}
                <span
                  className="term_controlIcon term_tooltipTrigger"
                  onClick={(e) => {
                    e.stopPropagation();
                    this.openInExternal();
                  }}
                  style={{display: 'flex', alignItems: 'center', cursor: 'pointer'}}
                >
                  <i className="ti ti-external-link" style={{fontSize: '14px'}} aria-hidden="true" />
                  <div className="term_tooltip" style={{minWidth: '180px'}}>
                    <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>Open in Chrome</div>
                    <div
                      style={{
                        fontSize: '11px',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-secondary)',
                        marginTop: 'var(--space-2)'
                      }}
                    >
                      System browser — bypasses bot walls
                    </div>
                  </div>
                </span>
                {showReload && (
                  <span
                    className="term_controlIcon term_tooltipTrigger"
                    onClick={(e) => {
                      e.stopPropagation();
                      this.reloadWebview(e.shiftKey);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      cursor: 'pointer'
                    }}
                  >
                    <i className="ti ti-refresh" style={{fontSize: '14px'}} aria-hidden="true" />
                    <div className="term_tooltip" style={{minWidth: '160px'}}>
                      <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>Reload</div>
                      <div
                        style={{
                          fontSize: '11px',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-secondary)',
                          marginTop: 'var(--space-2)'
                        }}
                      >
                        Reload · F5
                      </div>
                    </div>
                  </span>
                )}
                {showExternal && (
                  <span
                    className="term_controlIcon term_tooltipTrigger"
                    onClick={(e) => {
                      e.stopPropagation();
                      const url = this.state.activeUrl || this.props.url || '';
                      if (url) {
                        const {shell} = require('electron');
                        void shell.openExternal(url);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      cursor: 'pointer'
                    }}
                  >
                    <i className="ti ti-external-link" style={{fontSize: '14px'}} aria-hidden="true" />
                    <div className="term_tooltip" style={{minWidth: '160px'}}>
                      <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>
                        Open in system browser
                      </div>
                    </div>
                  </span>
                )}
                <span
                  className="term_controlIcon term_tooltipTrigger"
                  onClick={this.captureScreenshot}
                  style={{display: 'flex', alignItems: 'center', cursor: 'pointer'}}
                >
                  <i className="ti ti-camera" style={{fontSize: '14px'}} aria-hidden="true" />
                  <div className="term_tooltip" style={{minWidth: '200px'}}>
                    <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>Screenshot</div>
                    <div
                      style={{
                        fontSize: '11px',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-secondary)',
                        marginTop: 'var(--space-2)'
                      }}
                    >
                      Copy to clipboard + save to ~/.hyperia/snapshots
                    </div>
                  </div>
                </span>
                {!isAi && (
                  <span
                    className="term_controlIcon term_tooltipTrigger"
                    onClick={(e) => {
                      e.stopPropagation();
                      this.newStickyFromPage();
                    }}
                    style={{display: 'flex', alignItems: 'center', cursor: 'pointer'}}
                  >
                    <i className="ti ti-note" style={{fontSize: '14px'}} aria-hidden="true" />
                    <div className="term_tooltip" style={{minWidth: '160px'}}>
                      <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>
                        New sticky from page
                      </div>
                      <div
                        style={{
                          fontSize: '11px',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-secondary)',
                          marginTop: 'var(--space-2)'
                        }}
                      >
                        Title + URL + selection/extract
                      </div>
                    </div>
                  </span>
                )}
              </div>
            }
            locationBar={
              showUrlBar ? (
                <div
                  ref={this.urlBarRef}
                  className="web_locationBar"
                  onContextMenu={(e) => {
                    // Right-click the URL bar → Copy URL (this is toolbar chrome,
                    // not the guest page, so it's a plain renderer menu).
                    e.preventDefault();
                    e.stopPropagation();
                    const currentUrl = this.state.activeUrl || this.props.url || '';
                    try {
                      // eslint-disable-next-line @typescript-eslint/no-var-requires
                      const {Menu, MenuItem} = require('@electron/remote');
                      // eslint-disable-next-line @typescript-eslint/no-var-requires
                      const {clipboard} = require('electron');
                      const menu = new Menu();
                      menu.append(
                        new MenuItem({
                          label: 'Copy URL',
                          enabled: !!currentUrl,
                          click: () => {
                            try {
                              clipboard.writeText(currentUrl);
                            } catch (err) {
                              console.error('Copy URL failed:', err);
                            }
                          }
                        })
                      );
                      menu.popup();
                    } catch (err) {
                      console.error('URL bar context menu failed:', err);
                    }
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const isOpen = !this.state.isUrlNavigatorOpen;
                    let navigatorLeft = 8;
                    let navigatorWidth = 320;
                    let navigatorTop = 38;
                    if (isOpen) {
                      const el = this.urlBarRef.current;
                      const wrapper = this.webWrapperRef.current;
                      if (el && wrapper) {
                        const rect = el.getBoundingClientRect();
                        const parentRect = wrapper.getBoundingClientRect();
                        navigatorLeft = rect.left - parentRect.left;
                        navigatorTop = rect.bottom - parentRect.top + 4;
                        const widthToUse = Math.max(rect.width, 320);
                        navigatorWidth = widthToUse;
                        if (navigatorLeft + widthToUse > parentRect.width) {
                          // Right-justify and extend left
                          navigatorLeft = rect.right - parentRect.left - widthToUse;
                          if (navigatorLeft < 8) {
                            navigatorLeft = 8;
                          }
                        }
                      }
                    }
                    this.setState(
                      {
                        isUrlNavigatorOpen: isOpen,
                        navigatorInputVal: '',
                        navigatorFocusedIndex: -1,
                        navigatorError: null,
                        navigatorLeft,
                        navigatorWidth,
                        navigatorTop
                      },
                      () => {
                        if (isOpen) {
                          requestAnimationFrame(() => {
                            if (this.navigatorInputRef.current) {
                              this.navigatorInputRef.current.focus();
                              this.navigatorInputRef.current.select();
                            }
                          });
                        }
                      }
                    );
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-4)',
                    background: 'var(--bg-primary)',
                    border: '0.5px solid var(--border-focus)',
                    borderRadius: 'var(--radius-3)',
                    padding: '0 var(--space-6)',
                    height: '24px',
                    // Fill the row. Hard floor of ~11 chars ("https://" + a few
                    // letters); below that the whole bar is hidden (showUrlBar),
                    // never shrunk to a sub-"https://" stub.
                    flex: 1,
                    minWidth: '80px',
                    cursor: 'pointer',
                    boxSizing: 'border-box',
                    marginLeft: 'var(--space-4)',
                    marginRight: 'var(--space-8)'
                  }}
                  title={isAi ? 'Click to view recent threads' : 'Click to navigate'}
                >
                  {loading && url ? (
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
                      className={isAi ? 'ti ti-sparkles' : 'ti ti-world'}
                      style={{
                        fontSize: '12px',
                        color: isAi ? 'var(--color-ai-purple, #7F77DD)' : 'var(--info-text)',
                        flexShrink: 0
                      }}
                      aria-hidden="true"
                    />
                  )}
                  <span
                    style={{
                      fontFamily: isAi ? 'var(--font-sans)' : 'var(--font-mono)',
                      fontSize: '11px',
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {(() => {
                      if (isAi) {
                        const conversationId = url.slice(5);
                        const conv = this.state.aiConversations.find((c) => c.id === conversationId);
                        return conv ? conv.title : 'ask';
                      }
                      return this.state.activeUrl || this.props.url || 'about:blank';
                    })()}
                  </span>
                </div>
              ) : null
            }
            onSplitRight={() =>
              rpc.emit('split request vertical', {
                activeUid: this.props.sessionUid || this.props.groupUid,
                profile: 'picker'
              })
            }
            onSplitDown={() =>
              rpc.emit('split request horizontal', {activeUid: this.props.sessionUid || this.props.groupUid})
            }
            onSplitLeft={() =>
              rpc.emit('split request vertical', {
                activeUid: this.props.sessionUid || this.props.groupUid,
                splitPlacement: 'BEFORE'
              })
            }
            onSplitUp={() =>
              rpc.emit('split request horizontal', {
                activeUid: this.props.sessionUid || this.props.groupUid,
                splitPlacement: 'BEFORE'
              })
            }
            onClose={() => {
              if (hasSession) {
                onClose?.();
              } else {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                (this.props as any).onClosePane();
              }
            }}
            onContextMenu={this.handlePaneBandContextMenu}
            onClick={this.props.onActive}
            height={isAi ? 'normal' : 'compact'}
          />
        )}

        {this.state.isUrlNavigatorOpen && (
          <UrlNavigator
            url={url}
            sessionUid={this.props.sessionUid}
            groupUid={this.props.groupUid}
            navigatorTop={this.state.navigatorTop}
            navigatorLeft={this.state.navigatorLeft}
            navigatorWidth={this.state.navigatorWidth}
            navigatorInputVal={this.state.navigatorInputVal}
            navigatorFocusedIndex={this.state.navigatorFocusedIndex}
            navigatorError={this.state.navigatorError}
            aiConversations={this.state.aiConversations}
            webHistory={this.state.webHistory}
            saveHistory={this.state.saveHistory}
            loading={this.state.loading}
            hasAiConfigured={this.state.hasAiConfigured}
            expandedHistoryRoots={this.state.expandedHistoryRoots}
            navigatorInputRef={this.navigatorInputRef}
            urlNavigatorRef={this.urlNavigatorRef}
            onUpdateState={(updates) => this.setState(updates)}
            onNavigate={(url) => this.navigateWebview(url)}
            onCreateConversation={(id, query) => this.createConversation(id, query)}
            onClearAllHistory={() => this.clearAllHistory()}
            onClearAllAiConversations={() => this.clearAllAiConversations()}
            onRemoveAiConversation={(id) => this.removeAiConversation(id)}
            onRemoveHistoryEntry={(kind, value, visitedAt) => this.removeHistoryEntry(kind, value, visitedAt)}
            onToggleSaveHistory={this.toggleSaveHistory}
          />
        )}

        <div
          className={this.state.isUrlNavigatorOpen ? 'web_pane_dimmed' : ''}
          style={{flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden'}}
        >
          {/* Find-in-page bar (Ctrl+F) — floats top-right over the page. */}
          {this.state.findOpen && (
            <FindBar
              value={this.state.findText}
              active={this.state.findActive}
              total={this.state.findTotal}
              placeholder="Find in page"
              inputRef={this.findInputRef}
              onChange={(v) => {
                this.setState({findText: v});
                this.doFind(v, true);
              }}
              onNext={() => this.findStep(true)}
              onPrev={() => this.findStep(false)}
              onClose={this.closeFind}
            />
          )}
          {error && url && (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--bg-primary)',
                gap: 12
              }}
            >
              <span style={{fontSize: '48px'}}>🦕</span>
              <span
                style={{
                  fontSize: '14px',
                  color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-sans)',
                  fontWeight: 'var(--weight-medium)'
                }}
              >
                This page could not be loaded
              </span>
              <span
                style={{
                  fontSize: '11px',
                  color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-sans)',
                  maxWidth: 300,
                  textAlign: 'center'
                }}
              >
                {error}
              </span>
              <span style={{fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)'}}>
                {url}
              </span>
            </div>
          )}

          {(() => {
            if (isAi) {
              return (
                <AskAiView
                  url={url}
                  aiConversations={this.state.aiConversations}
                  aiStreamingMessage={this.state.aiStreamingMessage}
                  searchState={this.state.searchState}
                  searchLogs={this.state.searchLogs}
                  aiInputVal={this.state.aiInputVal}
                  onUpdateState={(updates) => this.setState(updates)}
                  onRunAiChat={(conversationId, val) => void this.runAiChat(conversationId, val)}
                  onStopAgentSearch={this.stopAgentSearch}
                />
              );
            }

            if (!url) {
              return (
                <div className="seeker_container">
                  {this.state.searchState === 'idle' ? (
                    <div className="seeker_search_idle">
                      <pre className="seeker_ascii">
                        {` __  __                      _
|  \\/  |_   _ _ __   ___ _ __(_) __ _
| |\\/| | | | | '_ \\ / _ \\ '__| |/ _\` |
| |  | | |_| | |_) |  __/ |  | | (_| |
|_|  |_|\\__, | .__/ \\___|_|  |_|\\__,_|
        |___/|_|  SEEK & SYNTHESIZE`}
                      </pre>
                      <div className="seeker_subtitle">🚀 SEEK & SYNTHESIZE Agentic Engine</div>

                      <div className="seeker_input_wrapper">
                        <span className="seeker_prompt_symbol">search &gt;</span>
                        <input
                          type="text"
                          className="seeker_input"
                          placeholder="type search query..."
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const val = (e.target as HTMLInputElement).value.trim();
                              if (val) {
                                void this.runAgentSearch(val);
                              }
                            }
                          }}
                          autoFocus
                        />
                      </div>

                      <div className="seeker_suggestions">
                        {[
                          'San Francisco weather',
                          'Calculate 15% tip on $85',
                          'Latest tech news',
                          'Translate hello to Japanese'
                        ].map((q) => (
                          <button
                            key={q}
                            onClick={() => {
                              void this.runAgentSearch(q);
                            }}
                            className="seeker_suggestion_btn"
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="seeker_search_active">
                      <div className="seeker_active_header">
                        <span className="seeker_active_query">&gt; seeking: &quot;{this.state.searchQuery}&quot;</span>
                        {this.state.searchState === 'searching' ? (
                          <button className="seeker_control_btn seeker_stop" onClick={this.stopAgentSearch}>
                            [Stop Search]
                          </button>
                        ) : (
                          <button
                            className="seeker_control_btn seeker_new"
                            onClick={() => this.setState({searchState: 'idle', searchQuery: ''})}
                          >
                            [New Search]
                          </button>
                        )}
                      </div>

                      <div className="seeker_scrollback">
                        {this.state.searchLogs.map((log) => {
                          const isRunning = log.status === 'running';
                          const isFail = log.status === 'fail';
                          const icon = isRunning ? '🔧' : isFail ? '✗' : '✓';
                          const statusColor = isRunning
                            ? 'var(--warning-text)'
                            : isFail
                              ? 'var(--danger-text)'
                              : 'var(--success-text)';
                          return (
                            <div key={log.id} className="seeker_log_row">
                              <div className="seeker_log_summary">
                                <span style={{color: statusColor, marginRight: '8px'}}>{icon}</span>
                                <span
                                  className="seeker_log_name"
                                  style={{color: isRunning ? 'var(--text-primary)' : 'var(--text-secondary)'}}
                                >
                                  {isRunning ? `running ${log.name}...` : `${log.name}`}
                                </span>
                                {!isRunning && log.output && (
                                  <button
                                    className="seeker_toggle_btn"
                                    onClick={() => {
                                      this.setState((state) => ({
                                        searchLogs: state.searchLogs.map((item) =>
                                          item.id === log.id ? {...item, expanded: !item.expanded} : item
                                        )
                                      }));
                                    }}
                                  >
                                    {log.expanded ? '[collapse]' : '[view output]'}
                                  </button>
                                )}
                              </div>
                              {log.expanded && !isRunning && (
                                <div className="seeker_log_details">
                                  {log.input && (
                                    <div style={{marginBottom: '6px'}}>
                                      <div style={{color: 'var(--text-tertiary)', fontSize: '10px'}}>INPUT:</div>
                                      <pre className="seeker_details_pre">{JSON.stringify(log.input, null, 2)}</pre>
                                    </div>
                                  )}
                                  {log.output && (
                                    <div>
                                      <div style={{color: 'var(--text-tertiary)', fontSize: '10px'}}>OUTPUT:</div>
                                      <pre className="seeker_details_pre">{log.output}</pre>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}

                        {this.state.searchText && (
                          <div className="seeker_text_synthesis">
                            <div
                              style={{
                                color: 'var(--info-text)',
                                fontSize: '11px',
                                fontWeight: 'bold',
                                marginBottom: '8px',
                                textTransform: 'uppercase',
                                letterSpacing: '1px'
                              }}
                            >
                              — Seeker Synthesis —
                            </div>
                            <div className="seeker_synthesis_body">
                              {this.state.searchText.split('\n').map((line, i) => (
                                <div key={i} style={{minHeight: '18px'}}>
                                  {line}
                                </div>
                              ))}
                              {this.state.searchState === 'searching' && <span className="seeker_cursor" />}
                            </div>
                          </div>
                        )}

                        {this.state.searchState === 'error' && this.state.searchError && (
                          <div className="seeker_error_block">
                            <span style={{color: 'var(--danger-text)', fontWeight: 'bold', marginRight: '6px'}}>
                              [Error]
                            </span>
                            <span>{this.state.searchError}</span>
                          </div>
                        )}

                        {this.state.searchStats && (
                          <div className="seeker_stats_row">
                            [Completed in {this.state.searchStats.turns} turns · Input:{' '}
                            {this.state.searchStats.inputTokens.toLocaleString()} tokens · Output:{' '}
                            {this.state.searchStats.outputTokens.toLocaleString()} tokens]
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            }

            return (
              /* Webview — always mounted so it can navigate */
              /* eslint-disable react/no-unknown-property */
              <webview
                ref={this.webviewRef}
                src={url}
                useragent={BROWSER_UA}
                // Without this, the guest can't request new windows, so
                // target="_blank"/window.open is silently blocked BEFORE the
                // main-process window-open handler runs — and the "split down +
                // open in a new pane" never fires. Enabling it lets that handler
                // intercept the popup and route it to a split.
                {...({allowpopups: 'true', webpreferences: 'spellcheck=yes'} as any)}
                style={{
                  flex: 1,
                  display: error ? 'none' : 'flex',
                  border: 'none',
                  outline: 'none',
                  // Default WHITE, not transparent — a transparent <webview> paints
                  // BLACK between repaints, so pages that don't expose a sampleable
                  // body bg (HN's legacy bgcolor, etc.) render black-on-black /
                  // flash. White is the safe ground; real dark pages paint over it.
                  backgroundColor: this.state.pageBgColor || '#ffffff'
                }}
              />
              /* eslint-enable react/no-unknown-property */
            );
          })()}
        </div>

        {loading && url && !showStrip && (
          <div
            style={{
              position: 'absolute',
              top: '6px',
              right: '10px',
              fontSize: '11px',
              color: 'var(--text-tertiary)',
              zIndex: 10,
              pointerEvents: 'none',
              animation: 'web-pane-spin 1s linear infinite'
            }}
          >
            ⟳
          </div>
        )}

        <style>{`
          @keyframes web-pane-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }


          .term_controlIcon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            color: var(--text-secondary);
            transition: color 0.15s ease;
            position: relative;
            padding: var(--space-2);
          }

          .term_controlIcon:hover {
            color: var(--text-primary);
          }

          .term_tooltipTrigger {
            position: relative;
          }

          .term_tooltip {
            display: none;
            position: absolute;
            top: 22px;
            right: -6px;
            background: var(--bg-primary);
            border: 0.5px solid var(--border-neutral);
            border-radius: var(--radius-4);
            padding: var(--space-8) var(--space-12);
            white-space: nowrap;
            z-index: 1000;
            min-width: 140px;
            text-align: left;
            pointer-events: none;
          }

          .term_tooltipTrigger:hover .term_tooltip {
            display: block;
          }

          /* The nav cluster sits at the far LEFT of the band; the default
             tooltip is right-anchored (opens leftward), which runs off the left
             edge of the screen here. Anchor these left so they open rightward
             into the pane instead. */
          .web-nav-cluster .term_tooltip {
            left: -6px;
            right: auto;
          }

          .web_pane_prompt_container {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-tertiary);
            padding: var(--space-20);
          }

          .web_pane_prompt_box {
            display: flex;
            align-items: center;
            gap: var(--space-12);
            background: var(--bg-secondary);
            border: 0.5px solid var(--border-neutral);
            border-radius: var(--radius-4);
            padding: var(--space-10) var(--space-16);
            width: 100%;
            max-width: 480px;
          }

          .web_pane_prompt_globe {
            font-size: 20px;
            user-select: none;
          }

          .web_pane_prompt_input {
            flex: 1;
            background: transparent;
            border: none;
            outline: none;
            color: var(--text-primary);
            font-size: 11px;
            font-family: var(--font-sans);
          }

          .web_pane_prompt_input::placeholder {
            color: var(--text-tertiary);
          }

          .web_pane_prompt_input:focus {
            box-shadow: 0 0 0 2px var(--border-neutral);
            border-radius: 2px;
          }
          .web_pane_dimmed {
            opacity: 0.35;
            filter: grayscale(40%);
            pointer-events: none;
            transition: opacity 0.15s ease;
          }
          .web_pane_navigator_input::selection {
            background: var(--info-bg);
            color: var(--info-text);
          }

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

          .seeker_container {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: #08080f;
            color: var(--text-primary);
            font-family: var(--font-mono);
            font-size: 13px;
            overflow: hidden;
            box-sizing: border-box;
          }

          .seeker_search_idle {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: var(--space-20);
            text-align: center;
            box-sizing: border-box;
          }

          .seeker_ascii {
            font-family: var(--font-mono);
            font-size: 10px;
            color: var(--accent);
            line-height: 1.25;
            margin-bottom: var(--space-12);
            white-space: pre;
            user-select: none;
          }

          .seeker_subtitle {
            font-size: 11px;
            color: var(--text-secondary);
            font-weight: var(--weight-medium);
            letter-spacing: 1px;
            text-transform: uppercase;
            margin-bottom: 30px;
          }

          .seeker_input_wrapper {
            display: flex;
            align-items: center;
            gap: var(--space-10);
            background: var(--bg-secondary);
            border: 0.5px solid var(--border-neutral);
            border-radius: var(--radius-4);
            padding: var(--space-6) var(--space-12);
            width: 100%;
            max-width: 500px;
            margin-bottom: var(--space-20);
            box-sizing: border-box;
          }

          .seeker_prompt_symbol {
            color: var(--info-text);
            user-select: none;
            font-weight: var(--weight-medium);
          }

          .seeker_input {
            flex: 1;
            background: transparent;
            border: none;
            outline: none;
            color: var(--text-primary);
            font-family: var(--font-mono);
            font-size: 13px;
            padding: 0;
          }

          .seeker_suggestions {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: var(--space-8);
            max-width: 550px;
          }

          .seeker_suggestion_btn {
            background: transparent;
            border: 0.5px solid var(--border-neutral);
            border-radius: var(--radius-3);
            padding: var(--space-4) var(--space-10);
            color: var(--text-secondary);
            font-family: var(--font-mono);
            font-size: 11px;
            cursor: pointer;
            transition: all 0.15s ease;
          }

          .seeker_suggestion_btn:hover {
            border-color: var(--info-text);
            color: var(--info-text);
            background: var(--info-bg);
          }

          .seeker_search_active {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            box-sizing: border-box;
          }

          .seeker_active_header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 16px;
            border-bottom: 0.5px solid var(--border-neutral);
            background: var(--bg-secondary);
            box-sizing: border-box;
            user-select: none;
          }

          .seeker_active_query {
            color: var(--info-text);
            font-weight: var(--weight-medium);
          }

          .seeker_control_btn {
            background: transparent;
            border: 0.5px solid transparent;
            border-radius: var(--radius-3);
            padding: var(--space-2) var(--space-8);
            font-family: var(--font-mono);
            font-size: 11px;
            cursor: pointer;
            transition: all 0.15s ease;
          }

          .seeker_stop {
            color: var(--danger-text);
            border-color: var(--danger-text);
          }

          .seeker_stop:hover {
            background: var(--danger-bg);
          }

          .seeker_new {
            color: var(--success-text);
            border-color: var(--success-text);
          }

          .seeker_new:hover {
            background: var(--success-bg);
          }

          .seeker_scrollback {
            flex: 1;
            overflow-y: auto;
            padding: var(--space-16);
            display: flex;
            flex-direction: column;
            gap: var(--space-12);
            box-sizing: border-box;
          }

          .seeker_log_row {
            display: flex;
            flex-direction: column;
            background: var(--bg-dim);
            border-left: 2px solid var(--border-neutral);
            padding: var(--space-4) 0 var(--space-4) var(--space-8);
            font-size: 12px;
          }

          .seeker_log_summary {
            display: flex;
            align-items: center;
            gap: var(--space-8);
          }

          .seeker_log_name {
            font-family: var(--font-mono);
          }

          .seeker_toggle_btn {
            background: transparent;
            border: none;
            outline: none;
            color: var(--info-text);
            font-family: var(--font-mono);
            font-size: 10px;
            cursor: pointer;
            margin-left: auto;
            padding: 0 var(--space-4);
          }

          .seeker_toggle_btn:hover {
            text-decoration: underline;
          }

          .seeker_log_details {
            margin-top: var(--space-6);
            padding: var(--space-6);
            background: var(--bg-soft);
            border: 0.5px solid var(--border-neutral);
            border-radius: var(--radius-3);
            font-size: 11px;
          }

          .seeker_details_pre {
            white-space: pre-wrap;
            word-break: break-all;
            font-family: var(--font-mono);
            color: var(--text-secondary);
            margin: var(--space-4) 0 0;
            max-height: 160px;
            overflow-y: auto;
          }

          .seeker_text_synthesis {
            border-left: 2px solid var(--info-text);
            padding: var(--space-8) 0 var(--space-8) var(--space-12);
            background: rgba(0, 150, 255, 0.02);
            line-height: 1.6;
          }

          .seeker_synthesis_body {
            color: var(--text-primary);
            white-space: pre-wrap;
          }

          @keyframes seeker-blink {
            0%, 49% { opacity: 1; }
            50%, 100% { opacity: 0; }
          }

          .seeker_cursor {
            display: inline-block;
            width: 7px;
            height: 14px;
            background: var(--info-text);
            margin-left: var(--space-4);
            vertical-align: middle;
            animation: seeker-blink 1s steps(1) infinite;
          }

          .seeker_error_block {
            background: var(--danger-bg);
            border-left: 2px solid var(--danger-text);
            padding: var(--space-8) var(--space-12);
            color: var(--text-primary);
            font-size: 12px;
          }

            font-size: 10px;
            margin-top: auto;
            padding-top: var(--space-10);
            border-top: 0.5px dashed var(--border-neutral);
            user-select: none;
          }

          webview {
            border: none !important;
            outline: none !important;
            width: 100%;
            height: 100%;
          }

          .web_fit {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            background: var(--bg-primary);
            container-type: inline-size;
            container-name: pane;
          }

          @container pane (max-width: 380px) {
            .web_locationBar {
              border-color: transparent !important;
              background: transparent !important;
              padding: 0 !important;
              width: fit-content !important;
              min-width: unset !important;
              max-width: unset !important;
              margin-right: 0 !important;
              margin-left: 0 !important;
            }
            .web_locationBar span {
              display: none !important;
            }
          }
        `}</style>
      </div>
    );
  }
}

const mapStateToProps = (state: any, ownProps: WebPaneProps) => {
  const termGroup = state.termGroups.termGroups[ownProps.groupUid];
  return {
    defaultProfile: state.ui.defaultProfile,
    profiles: state.ui.profiles
      ? state.ui.profiles.asMutable
        ? // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          state.ui.profiles.asMutable({deep: true})
        : state.ui.profiles
      : [],
    webName: termGroup ? termGroup.webName : undefined
  };
};

const mapDispatchToProps = (dispatch: HyperDispatch, ownProps: WebPaneProps) => ({
  onClose() {
    dispatch(clearWebPane(ownProps.groupUid) as any);
  },
  onClosePane() {
    dispatch(userExitTermGroup(ownProps.groupUid) as any);
  },
  onPopOutPane() {
    dispatch(popOutPane(ownProps.groupUid) as any);
  },
  onSetTitle(title: string) {
    dispatch({type: 'TERM_GROUP_SET_WEB_NAME', uid: ownProps.groupUid, name: title} as any);
  },
  onSetUrl(url: string) {
    dispatch({type: 'TERM_GROUP_SET_WEB_URL', uid: ownProps.groupUid, url} as any);
  },
  onActive() {
    dispatch({type: 'TERM_GROUP_SET_ACTIVE', uid: ownProps.groupUid} as any);
  },
  onSplitWebPane(url: string, direction: 'HORIZONTAL' | 'VERTICAL') {
    dispatch(splitWebPane(ownProps.groupUid, url, direction) as any);
  }
});

export default connect(mapStateToProps, mapDispatchToProps)(WebPane_);
