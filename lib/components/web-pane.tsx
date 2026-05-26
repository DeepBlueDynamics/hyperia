import React from 'react';

import {connect} from 'react-redux';

import type {HyperDispatch} from '../../typings/hyper';
import {clearWebPane, userExitTermGroup} from '../actions/term-groups';
import rpc from '../rpc';
import {PaneBand} from './pane-band';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {ipcMain, ipcRenderer} = require('electron');

// Match a real Chrome UA so sites don't block the request
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface WebPaneProps {
  url: string;
  groupUid: string;
  hasSession?: boolean; // true = overlaying a terminal; show × to restore it
  sessionUid?: string | null;
  splitLabel?: string;
  switchPaneProfile?: (groupUid: string, sessionUid: string | undefined, profileName: string) => void;
  switchPaneToWeb?: (groupUid: string, sessionUid: string | undefined, url?: string) => void;
  onClose?: () => void;
  onClosePane?: () => void;
  onSetTitle?: (title: string) => void;
  onSetUrl?: (url: string) => void;
}

const getSecurityState = (urlStr: string): 'https' | 'http' | 'localhost' | 'error' => {
  try {
    const trimmed = urlStr.trim();
    if (!trimmed) return 'error';
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed);
    const hostname = parsed.hostname;

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.test')
    ) {
      return 'localhost';
    }

    if (parsed.protocol === 'https:') {
      return 'https';
    }

    if (parsed.protocol === 'http:') {
      return 'http';
    }

    return 'error';
  } catch (err) {
    return 'error';
  }
};

const isValidUrl = (urlStr: string): boolean => {
  const trimmed = urlStr.trim();
  if (!trimmed) return false;

  if (/^(localhost|127\.0\.0\.1|.*\.local|.*\.test)(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return true;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      new URL(trimmed);
      return true;
    } catch (_) {
      return false;
    }
  }

  if (/^[a-z0-9]+([-.][a-z0-9]+)*\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return true;
  }

  return false;
};

interface WebHistoryEntry {
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
  isProfileMenuOpen?: boolean;
  showWebPaneInput?: boolean;
  webPaneUrlInput?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  activeUrl: string;
  isEditingUrl: boolean;
  urlInputVal: string;
  isUrlNavigatorOpen: boolean;
  webHistory: WebHistoryEntry[];
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
}

class WebPane_ extends React.PureComponent<WebPaneProps, WebPaneState> {
  webviewRef = React.createRef<any>();
  urlInputRef = React.createRef<HTMLInputElement>();
  urlNavigatorRef = React.createRef<HTMLDivElement>();
  urlBarRef = React.createRef<HTMLDivElement>();
  navigatorInputRef = React.createRef<HTMLInputElement>();
  _windowKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  searchAbortCtrl: AbortController | null = null;

  constructor(props: WebPaneProps) {
    super(props);
    let webHistory: WebHistoryEntry[] = [];
    try {
      const saved = localStorage.getItem(`web_pane_history_${props.groupUid}`);
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
      isProfileMenuOpen: false,
      showWebPaneInput: false,
      webPaneUrlInput: '',
      canGoBack: false,
      canGoForward: false,
      activeUrl: props.url || '',
      isEditingUrl: false,
      urlInputVal: '',
      isUrlNavigatorOpen: false,
      webHistory,
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
      paneHistoryIndex: props.url ? 0 : -1
    };
  }

  menuRef = React.createRef<HTMLDivElement>();
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
    if (e.key === 'F5') {
      e.preventDefault();
      e.stopPropagation();
      this.reloadWebview(e.shiftKey);
    }
  };

  navigateWebview = (targetUrl: string) => {
    this.props.onSetUrl?.(targetUrl);
    this.addToHistory('url', targetUrl);
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

  addToHistory = (kind: 'url' | 'ai-query', value: string, extra: Partial<WebHistoryEntry> = {}) => {
    const newEntry: WebHistoryEntry = {
      kind,
      value,
      visitedAt: Date.now(),
      ...extra
    };

    if (kind === 'url') {
      newEntry.securityState = getSecurityState(value);
    }

    const filtered = this.state.webHistory.filter((item) => !(item.kind === kind && item.value === value));
    const newHistory = [newEntry, ...filtered].slice(0, 200);

    this.setState({
      webHistory: newHistory
    });

    try {
      localStorage.setItem(`web_pane_history_${this.props.groupUid}`, JSON.stringify(newHistory));
    } catch (err) {
      console.error('Failed to persist web pane history:', err);
    }
  };

  handleOutsideClick = (e: MouseEvent) => {
    if (
      this.menuRef.current &&
      !this.menuRef.current.contains(e.target as Node) &&
      this.labelRef.current &&
      !this.labelRef.current.contains(e.target as Node)
    ) {
      this.setState({isProfileMenuOpen: false, showWebPaneInput: false, isEditingUrl: false});
    }

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

  toggleProfileMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    this.setState((state) => ({
      isProfileMenuOpen: !state.isProfileMenuOpen,
      showWebPaneInput: false,
      webPaneUrlInput: ''
    }));
  };

  handleShellProfileSelect = (p: any) => {
    const {groupUid, sessionUid, switchPaneProfile} = this.props as any;
    if (switchPaneProfile && groupUid) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      switchPaneProfile(groupUid, sessionUid, p.name);
    }
    this.setState({isProfileMenuOpen: false, showWebPaneInput: false});
  };

  handleRightClickProfile = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      ipcRenderer.send('set-default-profile', name);
    } catch (err) {
      console.error('Failed to set default profile:', err);
    }
  };

  handleWebPaneSelect = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    this.setState({showWebPaneInput: true}, () => {
      requestAnimationFrame(() => {
        this.inputRef.current?.focus();
      });
    });
  };

  handleWebPaneSubmit = () => {
    const trimmed = (this.state.webPaneUrlInput || '').trim();
    if (!trimmed) return;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
    const {groupUid, sessionUid, switchPaneToWeb} = this.props as any;
    if (switchPaneToWeb && groupUid) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      switchPaneToWeb(groupUid, sessionUid, url);
    }
    this.setState({isProfileMenuOpen: false, showWebPaneInput: false, webPaneUrlInput: ''});
  };

  handleWebPaneCancel = () => {
    this.setState({showWebPaneInput: false, webPaneUrlInput: ''});
  };

  isInputUrl = (val: string): boolean => {
    return isValidUrl(val.trim());
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

  handlePopupKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const val = this.state.navigatorInputVal;
    const query = val.toLowerCase();
    const filtered = query
      ? this.state.webHistory.filter((item) => item.value.toLowerCase().includes(query))
      : this.state.webHistory;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.state.navigatorInputVal) {
        this.setState({
          navigatorInputVal: '',
          navigatorFocusedIndex: -1,
          navigatorError: null
        });
      } else {
        this.setState({
          isUrlNavigatorOpen: false
        });
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length > 0) {
        const nextIndex = (this.state.navigatorFocusedIndex + 1) % filtered.length;
        this.setState({navigatorFocusedIndex: nextIndex});
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length > 0) {
        const prevIndex =
          this.state.navigatorFocusedIndex <= 0 ? filtered.length - 1 : this.state.navigatorFocusedIndex - 1;
        this.setState({navigatorFocusedIndex: prevIndex});
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const idx = this.state.navigatorFocusedIndex;
      if (idx >= 0 && idx < filtered.length) {
        const item = filtered[idx];
        if (item.kind === 'ai-query') {
          const conversationId = item.conversationId || `conv-${Date.now()}`;
          if (e.shiftKey) {
            const newConvId = `conv-${Date.now()}`;
            this.createConversation(newConvId, item.value);
            const isCurrentPaneEmpty = !this.props.url || this.props.url === 'about:blank' || this.props.url === '';
            if (isCurrentPaneEmpty) {
              this.navigateWebview(`ai://${newConvId}`);
            } else {
              rpc.emit('split request vertical', {
                activeUid: this.props.sessionUid,
                profile: 'Web Pane',
                url: `ai://${newConvId}`
              });
            }
          } else {
            this.navigateWebview(`ai://${conversationId}`);
          }
        } else {
          this.navigateWebview(item.value);
        }
        this.setState({isUrlNavigatorOpen: false});
      } else {
        const trimmed = val.trim();
        if (trimmed) {
          const isUrl = this.isInputUrl(trimmed);
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
            this.navigateWebview(finalUrl);
            this.setState({isUrlNavigatorOpen: false});
          } else {
            if (!this.state.hasAiConfigured) {
              this.setState({navigatorError: 'AI not configured — please check settings'});
              return;
            }

            const conversationId = 'conv-' + Date.now();
            this.createConversation(conversationId, trimmed);

            const isCurrentPaneEmpty = !this.props.url || this.props.url === 'about:blank' || this.props.url === '';
            if (isCurrentPaneEmpty) {
              this.navigateWebview(`ai://${conversationId}`);
            } else {
              rpc.emit('split request vertical', {
                activeUid: this.props.sessionUid,
                profile: 'Web Pane',
                url: `ai://${conversationId}`
              });
            }
            this.setState({isUrlNavigatorOpen: false});
          }
        }
      }
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

    const wasActive = prevState.isProfileMenuOpen || prevState.isEditingUrl || prevState.isUrlNavigatorOpen;
    const isActive = this.state.isProfileMenuOpen || this.state.isEditingUrl || this.state.isUrlNavigatorOpen;

    if (isActive && !wasActive) {
      document.addEventListener('mousedown', this.handleOutsideClick);
    } else if (!isActive && wasActive) {
      document.removeEventListener('mousedown', this.handleOutsideClick);
    }
  }

  componentDidMount() {
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

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    wv.addEventListener('did-start-loading', () => {
      this.setState({loading: true, error: null});
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    wv.addEventListener('did-stop-loading', () => {
      this.setState({loading: false});
      this.updateNavigationState();
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    wv.addEventListener('did-fail-load', (e: {errorCode: number; errorDescription: string}) => {
      if (e.errorCode === -3) return;
      this.setState({loading: false, error: e.errorDescription || 'Failed to load'});
    });

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
      }
    };

    /* eslint-disable @typescript-eslint/no-unsafe-call */
    wv.addEventListener('did-navigate', handleNavigation);
    wv.addEventListener('did-navigate-in-page', handleNavigation);

    wv.addEventListener('dom-ready', () => {
      this.updateNavigationState();
    });
    /* eslint-enable @typescript-eslint/no-unsafe-call */

    // Listen for Ctrl+L shortcut
    this._windowKeydownHandler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        e.stopPropagation();
        this.setState(
          {
            isUrlNavigatorOpen: true,
            navigatorInputVal: this.state.activeUrl || this.props.url || '',
            navigatorFocusedIndex: 0,
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

    // Listen for reload requests from the tab right-click menu
    this._reloadHandler = (uid: string) => {
      if (uid === this.props.groupUid && this.webviewRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        this.webviewRef.current.reload();
      }
    };
    rpc.on('web-pane-reload', this._reloadHandler);
    this.checkAndTriggerInitialAiChat();
  }

  componentWillUnmount() {
    document.removeEventListener('mousedown', this.handleOutsideClick);
    if (this._windowKeydownHandler) {
      window.removeEventListener('keydown', this._windowKeydownHandler);
    }
    if (this._reloadHandler) {
      rpc.removeListener('web-pane-reload', this._reloadHandler);
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
    // Always show — shell pane handles the no-token case via bootstub.
    menu.append(new MenuItem({label: 'Ask Hyperia', click: () => void ipcMain.emit('open-ghost')}));
    menu.append(new MenuItem({type: 'separator'}));
    menu.append(new MenuItem({label: 'Close Tab', click: () => this.props.onClose?.()}));
    menu.popup();
    /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call */
  };

  handlePaneBandContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call */
    const remote = require('@electron/remote');
    const {Menu, MenuItem} = remote;
    const menu = new Menu();

    menu.append(
      new MenuItem({
        label: 'Split Right',
        accelerator: 'Ctrl+Shift+|',
        click: () => {
          rpc.emit('split request vertical', {activeUid: this.props.sessionUid});
        }
      })
    );

    menu.append(
      new MenuItem({
        label: 'Split Down',
        accelerator: 'Ctrl+Shift+_',
        click: () => {
          rpc.emit('split request horizontal', {activeUid: this.props.sessionUid});
        }
      })
    );

    menu.append(
      new MenuItem({
        label: 'Clone Right',
        accelerator: 'Ctrl+Alt+Shift+|',
        click: () => {
          rpc.emit('split request vertical', {
            activeUid: this.props.sessionUid || undefined,
            profile: (this.props as any).defaultProfile || undefined
          });
        }
      })
    );

    menu.append(
      new MenuItem({
        label: 'Clone Down',
        accelerator: 'Ctrl+Alt+Shift+_',
        click: () => {
          rpc.emit('split request horizontal', {
            activeUid: this.props.sessionUid || undefined,
            profile: (this.props as any).defaultProfile || undefined
          });
        }
      })
    );

    menu.append(new MenuItem({type: 'separator'}));

    menu.append(
      new MenuItem({
        label: 'Rename Pane',
        click: () => {
          const val = prompt('Enter pane name:', this.props.splitLabel ? `Pane ${this.props.splitLabel}` : 'Web pane');
          if (val && (this.props as any).onSetTitle) {
            (this.props as any).onSetTitle(val.trim());
          }
        }
      })
    );

    menu.append(new MenuItem({type: 'separator'}));

    menu.append(
      new MenuItem({
        label: 'Close Pane',
        accelerator: 'Ctrl+Shift+W',
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
    const {url, onClose, hasSession} = this.props;
    const {error, loading} = this.state;
    const splitLabel = (this.props as any).splitLabel;
    const showStrip = !!splitLabel || hasSession;
    const isAi = url && url.startsWith('ai://');
    const tint = isAi
      ? 'ai'
      : splitLabel === 'a'
        ? 'success'
        : splitLabel === 'b'
          ? 'info'
          : splitLabel === 'c'
            ? 'warning'
            : splitLabel === 'd'
              ? 'danger'
              : 'info';
    const labelText = isAi ? 'ask' : splitLabel ? `Pane ${splitLabel}` : 'Web pane';

    return (
      <div
        onKeyDown={this.handleKeyDown}
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
          background: 'var(--bg-primary)'
        }}
      >
        {showStrip && (
          <PaneBand
            ref={this.labelRef}
            paneType={isAi ? 'ai' : 'web'}
            tint={tint as any}
            label={labelText}
            navCluster={
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  marginLeft: 'var(--space-6)',
                  flexShrink: 0
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <span
                  className="term_controlIcon term_tooltipTrigger"
                  onClick={this.goBack}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    cursor: this.state.canGoBack ? 'pointer' : 'default',
                    opacity: this.state.canGoBack ? 0.4 : 1,
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
                <span
                  className="term_controlIcon term_tooltipTrigger"
                  onClick={this.goForward}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    cursor: this.state.canGoForward ? 'pointer' : 'default',
                    opacity: this.state.canGoForward ? 0.4 : 1,
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
                {!isAi && (
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
              </div>
            }
            locationBar={
              <div
                ref={this.urlBarRef}
                onClick={(e) => {
                  e.stopPropagation();
                  const isOpen = !this.state.isUrlNavigatorOpen;
                  this.setState(
                    {
                      isUrlNavigatorOpen: isOpen,
                      navigatorInputVal: isAi ? '' : this.state.activeUrl || this.props.url || '',
                      navigatorFocusedIndex: 0,
                      navigatorError: null
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
                  border: this.state.isUrlNavigatorOpen
                    ? '0.5px solid var(--border-focus)'
                    : '0.5px solid var(--border-neutral)',
                  borderRadius: 'var(--radius-3)',
                  padding: '0 var(--space-6)',
                  height: '18px',
                  flex: 1,
                  minWidth: 0,
                  maxWidth: '380px',
                  cursor: 'pointer',
                  boxSizing: 'border-box',
                  marginLeft: 'var(--space-4)',
                  marginRight: 'var(--space-8)'
                }}
                title={isAi ? 'Click to view recent threads' : 'Click to edit URL'}
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
                      color: isAi
                        ? 'var(--color-ai-purple, #7F77DD)'
                        : this.state.isUrlNavigatorOpen
                          ? 'var(--text-tertiary)'
                          : 'var(--text-secondary)',
                      flexShrink: 0
                    }}
                    aria-hidden="true"
                  />
                )}
                <span
                  style={{
                    fontFamily: isAi ? 'var(--font-sans)' : 'var(--font-mono)',
                    fontSize: '10px',
                    color: this.state.isUrlNavigatorOpen ? 'var(--text-tertiary)' : 'var(--text-secondary)',
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
            }
            onSplitRight={() => rpc.emit('split request vertical', {activeUid: this.props.sessionUid})}
            onSplitDown={() => rpc.emit('split request horizontal', {activeUid: this.props.sessionUid})}
            onClose={() => {
              if (hasSession) {
                onClose?.();
              } else {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                (this.props as any).onClosePane();
              }
            }}
            onClick={this.toggleProfileMenu}
            onContextMenu={this.handlePaneBandContextMenu}
            height={isAi ? 'normal' : 'compact'}
          />
        )}

        {this.state.isUrlNavigatorOpen && (
          <div
            ref={this.urlNavigatorRef}
            style={{
              position: 'absolute',
              top: '24px',
              left: '8px',
              right: '8px',
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
            {/* Top: editable URL input */}
            {/* Top: editable URL input */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                borderBottom: '0.5px solid var(--border-neutral)',
                boxSizing: 'border-box'
              }}
            >
              <i
                className={(() => {
                  const val = this.state.navigatorInputVal.trim();
                  if (!val) {
                    if (isAi) return 'ti ti-sparkles';
                    const state = getSecurityState(this.state.activeUrl || this.props.url || '');
                    return state === 'https'
                      ? 'ti ti-lock'
                      : state === 'http'
                        ? 'ti ti-lock-open'
                        : state === 'localhost'
                          ? 'ti ti-flask'
                          : 'ti ti-alert-triangle';
                  }
                  if (this.isInputUrl(val)) {
                    const state = getSecurityState(val);
                    return state === 'https'
                      ? 'ti ti-lock'
                      : state === 'http'
                        ? 'ti ti-lock-open'
                        : state === 'localhost'
                          ? 'ti ti-flask'
                          : 'ti ti-alert-triangle';
                  }
                  return 'ti ti-sparkles';
                })()}
                style={{
                  fontSize: '13px',
                  color: (() => {
                    const val = this.state.navigatorInputVal.trim();
                    if (!val) {
                      if (isAi) return 'var(--color-ai-purple, #7F77DD)';
                      const state = getSecurityState(this.state.activeUrl || this.props.url || '');
                      return state === 'https'
                        ? 'var(--success-text)'
                        : state === 'http'
                          ? 'var(--warning-text)'
                          : state === 'localhost'
                            ? 'var(--info-text)'
                            : 'var(--danger-text)';
                    }
                    if (this.isInputUrl(val)) {
                      const state = getSecurityState(val);
                      return state === 'https'
                        ? 'var(--success-text)'
                        : state === 'http'
                          ? 'var(--warning-text)'
                          : state === 'localhost'
                            ? 'var(--info-text)'
                            : 'var(--danger-text)';
                    }
                    return 'var(--color-ai-purple, #7F77DD)';
                  })()
                }}
              />
              <input
                ref={this.navigatorInputRef}
                type="text"
                className="web_pane_navigator_input"
                value={this.state.navigatorInputVal}
                onChange={(e) => {
                  const val = e.target.value;
                  const query = val.toLowerCase();
                  const filtered = query
                    ? this.state.webHistory.filter((item) => item.value.toLowerCase().includes(query))
                    : this.state.webHistory;
                  this.setState({
                    navigatorInputVal: val,
                    navigatorFocusedIndex: filtered.length > 0 ? 0 : -1,
                    navigatorError: null
                  });
                }}
                onKeyDown={this.handlePopupKeyDown}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  fontFamily:
                    (url && url.startsWith('ai://')) ||
                    (this.state.navigatorInputVal.trim() && !this.isInputUrl(this.state.navigatorInputVal))
                      ? 'var(--font-sans)'
                      : 'var(--font-mono)',
                  fontSize: '11px',
                  color: 'var(--text-primary)',
                  padding: 0
                }}
                placeholder={
                  url && url.startsWith('ai://')
                    ? 'Search threads or ask a new question...'
                    : 'Type URL or search history...'
                }
              />
              <span
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-tertiary)',
                  border: '0.5px solid var(--border-neutral)',
                  borderRadius: '3px',
                  padding: '1px 4px',
                  userSelect: 'none',
                  flexShrink: 0
                }}
                title="Press Enter to navigate"
              >
                ↵
              </span>
            </div>

            {/* Error Message if invalid */}
            {this.state.navigatorError && (
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
                {this.state.navigatorError}
              </div>
            )}

            {/* Body: history list */}
            <div
              style={{
                maxHeight: '200px',
                overflowY: 'auto'
              }}
            >
              {(() => {
                const query = this.state.navigatorInputVal.toLowerCase();

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
                      <span style={{textDecoration: 'underline', textUnderlineOffset: '2px'}}>{matched}</span>
                      {after}
                    </span>
                  );
                };

                if (isAi) {
                  const filtered = query
                    ? this.state.aiConversations.filter((c) => c.title.toLowerCase().includes(query))
                    : this.state.aiConversations;

                  if (filtered.length === 0) {
                    return (
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
                    );
                  }

                  return filtered.map((item, index) => {
                    const isFocused = index === this.state.navigatorFocusedIndex;
                    return (
                      <div
                        key={item.id}
                        onClick={() => {
                          this.navigateWebview(`ai://${item.id}`);
                          this.setState({isUrlNavigatorOpen: false});
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
                          {highlightMatch(item.title, this.state.navigatorInputVal)}
                        </span>
                      </div>
                    );
                  });
                }

                const filtered = query
                  ? this.state.webHistory.filter((item) => item.value.toLowerCase().includes(query))
                  : this.state.webHistory;

                if (filtered.length === 0) {
                  return (
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
                  );
                }

                return filtered.map((item, index) => {
                  const isFocused = index === this.state.navigatorFocusedIndex;
                  const isAiRow = item.kind === 'ai-query';

                  const secState = isAiRow ? 'localhost' : item.securityState || getSecurityState(item.value);
                  const iconClass = isAiRow
                    ? 'ti ti-sparkles'
                    : secState === 'https'
                      ? 'ti ti-lock'
                      : secState === 'http'
                        ? 'ti ti-lock-open'
                        : secState === 'localhost'
                          ? 'ti ti-flask'
                          : 'ti ti-alert-triangle';
                  const iconColor = isAiRow
                    ? 'var(--color-ai-purple, #7F77DD)'
                    : secState === 'https'
                      ? 'var(--success-text)'
                      : secState === 'http'
                        ? 'var(--warning-text)'
                        : secState === 'localhost'
                          ? 'var(--info-text)'
                          : 'var(--danger-text)';

                  return (
                    <div
                      key={`${item.value}-${item.visitedAt}`}
                      onClick={(e) => {
                        if (isAiRow) {
                          const conversationId = item.conversationId || `conv-${Date.now()}`;
                          if (e.shiftKey) {
                            const newConvId = `conv-${Date.now()}`;
                            this.createConversation(newConvId, item.value);
                            const isCurrentPaneEmpty =
                              !this.props.url || this.props.url === 'about:blank' || this.props.url === '';
                            if (isCurrentPaneEmpty) {
                              this.navigateWebview(`ai://${newConvId}`);
                            } else {
                              rpc.emit('split request vertical', {
                                activeUid: this.props.sessionUid,
                                profile: 'Web Pane',
                                url: `ai://${newConvId}`
                              });
                            }
                          } else {
                            this.navigateWebview(`ai://${conversationId}`);
                          }
                          this.setState({isUrlNavigatorOpen: false});
                        } else {
                          this.navigateWebview(item.value);
                          this.setState({isUrlNavigatorOpen: false});
                        }
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
                        className={iconClass}
                        style={{
                          fontSize: '13px',
                          color: isFocused
                            ? isAiRow
                              ? 'var(--color-ai-purple, #7F77DD)'
                              : 'var(--info-text)'
                            : iconColor,
                          flexShrink: 0
                        }}
                      />
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
                        {highlightMatch(item.value, this.state.navigatorInputVal)}
                      </span>
                    </div>
                  );
                });
              })()}
            </div>

            {/* Footer */}
            {(() => {
              const val = this.state.navigatorInputVal;
              const query = val.toLowerCase();

              const filtered = isAi
                ? query
                  ? this.state.aiConversations.filter((c) => c.title.toLowerCase().includes(query))
                  : this.state.aiConversations
                : query
                  ? this.state.webHistory.filter((item) => item.value.toLowerCase().includes(query))
                  : this.state.webHistory;

              const isTyping = val !== (this.state.activeUrl || this.props.url || '');

              if (isTyping && val.trim()) {
                const trimmed = val.trim();
                const isUrl = this.isInputUrl(trimmed);
                const hasAi = this.state.hasAiConfigured;

                let leftText = '';
                let leftColor = 'var(--text-tertiary)';
                if (isAi) {
                  leftText = '✨ AI query · Enter starts new thread';
                } else if (isUrl) {
                  leftText = '🌐 URL · Enter navigates';
                } else if (!hasAi) {
                  leftText = '✨ AI not configured — see settings';
                  leftColor = 'var(--warning-text)';
                } else {
                  const isPlausibleHost = !/\s/.test(trimmed);
                  leftText = `✨ AI query · Enter sends to Claude${isPlausibleHost ? ' (Ctrl+Enter to navigate as URL)' : ''}`;
                }

                return (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 12px',
                      borderTop: '0.5px solid var(--border-neutral)',
                      boxSizing: 'border-box'
                    }}
                  >
                    <span style={{fontSize: '10px', color: leftColor, fontFamily: 'var(--font-sans)', fontWeight: 500}}>
                      {leftText}
                    </span>
                    <span style={{fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)'}}>
                      Esc to clear
                    </span>
                  </div>
                );
              }

              const count = filtered.length;
              return (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '6px 12px',
                    borderTop: '0.5px solid var(--border-neutral)',
                    boxSizing: 'border-box'
                  }}
                >
                  <span style={{fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)'}}>
                    {isAi
                      ? `${count} ${count === 1 ? 'active thread' : 'active threads'}`
                      : `${count} ${count === 1 ? 'recent visit' : 'recent visits'}`}
                  </span>
                  <span style={{fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)'}}>
                    Esc to close
                  </span>
                </div>
              );
            })()}
          </div>
        )}

        <div
          className={this.state.isUrlNavigatorOpen ? 'web_pane_dimmed' : ''}
          style={{flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden'}}
        >
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
              const conversationId = url.slice(5);
              const activeConv = this.state.aiConversations.find((c) => c.id === conversationId) || {
                id: conversationId,
                title: 'ask',
                messages: []
              };

              return (
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    background: 'var(--bg-primary)',
                    position: 'relative',
                    overflow: 'hidden'
                  }}
                  className="ai_pane_container"
                >
                  {/* Chat feed scroll area */}
                  <div
                    style={{
                      flex: 1,
                      overflowY: 'auto',
                      padding: '16px 20px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '16px',
                      boxSizing: 'border-box'
                    }}
                    className="ai_pane_feed"
                  >
                    {activeConv.messages.map(
                      (msg: {role: 'user' | 'assistant'; content: string; timestamp: number}, idx: number) => {
                        const isUser = msg.role === 'user';
                        return (
                          <div
                            key={idx}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: isUser ? 'flex-end' : 'flex-start',
                              width: '100%'
                            }}
                          >
                            <div
                              style={{
                                maxWidth: '85%',
                                background: isUser ? 'var(--info-bg)' : 'var(--bg-secondary)',
                                color: isUser ? 'var(--info-text)' : 'var(--text-primary)',
                                border: '0.5px solid var(--border-neutral)',
                                borderRadius: '4px',
                                padding: '8px 12px',
                                boxSizing: 'border-box',
                                fontFamily: 'var(--font-sans)',
                                fontSize: '11px',
                                lineHeight: '1.5',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word'
                              }}
                            >
                              {(() => {
                                const parts = msg.content.split(/(```[\s\S]*?```)/g);
                                return parts.map((part: string, pIdx: number) => {
                                  if (part.startsWith('```')) {
                                    const code = part.replace(/```[a-zA-Z0-9]*\n?|```$/g, '');
                                    return (
                                      <pre
                                        key={pIdx}
                                        style={{
                                          fontFamily: 'var(--font-mono)',
                                          background: 'var(--bg-tertiary)',
                                          padding: '8px',
                                          borderRadius: '3px',
                                          overflowX: 'auto',
                                          margin: '6px 0 0 0',
                                          border: '0.5px solid var(--border-neutral)',
                                          textAlign: 'left'
                                        }}
                                      >
                                        <code>{code}</code>
                                      </pre>
                                    );
                                  }
                                  return <span key={pIdx}>{part}</span>;
                                });
                              })()}
                            </div>
                          </div>
                        );
                      }
                    )}

                    {/* Streaming message from assistant */}
                    {this.state.aiStreamingMessage && (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          width: '100%'
                        }}
                      >
                        <div
                          style={{
                            maxWidth: '85%',
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            border: '0.5px solid var(--border-neutral)',
                            borderRadius: '4px',
                            padding: '8px 12px',
                            boxSizing: 'border-box',
                            fontFamily: 'var(--font-sans)',
                            fontSize: '11px',
                            lineHeight: '1.5',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word'
                          }}
                        >
                          {(() => {
                            const parts = this.state.aiStreamingMessage.split(/(```[\s\S]*?```)/g);
                            return parts.map((part: string, pIdx: number) => {
                              if (part.startsWith('```')) {
                                const code = part.replace(/```[a-zA-Z0-9]*\n?|```$/g, '');
                                return (
                                  <pre
                                    key={pIdx}
                                    style={{
                                      fontFamily: 'var(--font-mono)',
                                      background: 'var(--bg-tertiary)',
                                      padding: '8px',
                                      borderRadius: '3px',
                                      overflowX: 'auto',
                                      margin: '6px 0 0 0',
                                      border: '0.5px solid var(--border-neutral)',
                                      textAlign: 'left'
                                    }}
                                  >
                                    <code>{code}</code>
                                  </pre>
                                );
                              }
                              return (
                                <span key={pIdx}>
                                  {part}
                                  {pIdx === parts.length - 1 && <span className="seeker_cursor" />}
                                </span>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    )}

                    {/* Tool executions accordion */}
                    {this.state.searchState === 'searching' && this.state.searchLogs.length > 0 && (
                      <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
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
                            <div
                              key={log.id}
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                border: '0.5px solid var(--border-neutral)',
                                borderRadius: '4px',
                                background: 'var(--bg-secondary)',
                                padding: '6px 12px',
                                boxSizing: 'border-box'
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  fontSize: '11px',
                                  fontFamily: 'var(--font-mono)'
                                }}
                              >
                                <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                                  <span style={{color: statusColor}}>{icon}</span>
                                  <span style={{color: isRunning ? 'var(--text-primary)' : 'var(--text-secondary)'}}>
                                    {isRunning ? `running ${log.name}...` : `${log.name}`}
                                  </span>
                                </div>
                                {!isRunning && log.output && (
                                  <button
                                    onClick={() => {
                                      this.setState((state) => ({
                                        searchLogs: state.searchLogs.map((item) =>
                                          item.id === log.id ? {...item, expanded: !item.expanded} : item
                                        )
                                      }));
                                    }}
                                    style={{
                                      background: 'transparent',
                                      border: 'none',
                                      color: 'var(--info-text)',
                                      fontFamily: 'var(--font-mono)',
                                      fontSize: '10px',
                                      cursor: 'pointer',
                                      padding: 0
                                    }}
                                  >
                                    {log.expanded ? '[collapse]' : '[view output]'}
                                  </button>
                                )}
                              </div>
                              {log.expanded && !isRunning && (
                                <div
                                  style={{
                                    marginTop: '6px',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '6px',
                                    textAlign: 'left'
                                  }}
                                >
                                  {log.input && (
                                    <div>
                                      <div
                                        style={{
                                          color: 'var(--text-tertiary)',
                                          fontSize: '10px',
                                          fontFamily: 'var(--font-mono)'
                                        }}
                                      >
                                        INPUT:
                                      </div>
                                      <pre
                                        style={{
                                          fontFamily: 'var(--font-mono)',
                                          background: 'var(--bg-tertiary)',
                                          padding: '6px',
                                          margin: 0,
                                          borderRadius: '3px',
                                          overflowX: 'auto',
                                          border: '0.5px solid var(--border-neutral)',
                                          fontSize: '10px'
                                        }}
                                      >
                                        {JSON.stringify(log.input, null, 2)}
                                      </pre>
                                    </div>
                                  )}
                                  {log.output && (
                                    <div>
                                      <div
                                        style={{
                                          color: 'var(--text-tertiary)',
                                          fontSize: '10px',
                                          fontFamily: 'var(--font-mono)'
                                        }}
                                      >
                                        OUTPUT:
                                      </div>
                                      <pre
                                        style={{
                                          fontFamily: 'var(--font-mono)',
                                          background: 'var(--bg-tertiary)',
                                          padding: '6px',
                                          margin: 0,
                                          borderRadius: '3px',
                                          overflowX: 'auto',
                                          border: '0.5px solid var(--border-neutral)',
                                          fontSize: '10px'
                                        }}
                                      >
                                        {log.output}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Follow-up bottom input field */}
                  <div
                    style={{
                      padding: '12px 20px',
                      borderTop: '0.5px solid var(--border-neutral)',
                      background: 'var(--bg-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      boxSizing: 'border-box'
                    }}
                  >
                    <span style={{fontSize: '12px', color: 'var(--color-ai-purple, #7F77DD)'}}>✨</span>
                    <input
                      type="text"
                      style={{
                        flex: 1,
                        background: 'transparent',
                        border: 'none',
                        outline: 'none',
                        color: 'var(--text-primary)',
                        fontFamily: 'var(--font-sans)',
                        fontSize: '11px',
                        padding: 0
                      }}
                      placeholder="Ask a follow-up question..."
                      value={this.state.aiInputVal}
                      onChange={(e) => this.setState({aiInputVal: e.target.value})}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const val = this.state.aiInputVal.trim();
                          if (val && this.state.searchState !== 'searching') {
                            void this.runAiChat(conversationId, val);
                          }
                        }
                      }}
                      disabled={this.state.searchState === 'searching'}
                    />
                    {this.state.searchState === 'searching' ? (
                      <button
                        onClick={this.stopAgentSearch}
                        style={{
                          background: 'var(--danger-bg)',
                          color: 'var(--danger-text)',
                          border: '0.5px solid var(--border-neutral)',
                          borderRadius: '3px',
                          fontSize: '10px',
                          fontFamily: 'var(--font-mono)',
                          padding: '2px 6px',
                          cursor: 'pointer'
                        }}
                      >
                        [Stop]
                      </button>
                    ) : (
                      <span style={{fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)'}}>
                        ↵
                      </span>
                    )}
                  </div>
                </div>
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
                style={{flex: 1, display: error ? 'none' : 'flex'}}
              />
              /* eslint-enable react/no-unknown-property */
            );
          })()}
        </div>

        {this.state.isProfileMenuOpen && (
          <div ref={this.menuRef} className="term_profileMenu">
            {this.state.showWebPaneInput ? (
              <div className="term_webPaneInputRow">
                <span className="term_globeIcon">🌐</span>
                <input
                  ref={this.inputRef}
                  type="text"
                  className="term_webPaneInput"
                  placeholder="Type URL & hit Enter..."
                  value={this.state.webPaneUrlInput}
                  onChange={(e) => this.setState({webPaneUrlInput: e.target.value})}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      this.handleWebPaneSubmit();
                    } else if (e.key === 'Escape') {
                      e.stopPropagation();
                      this.handleWebPaneCancel();
                    }
                  }}
                />
              </div>
            ) : (
              <>
                <div className="term_menuTitle">Switch Profile</div>
                {/* eslint-disable-next-line @typescript-eslint/no-unsafe-call */}
                {((this.props as any).profiles || []).map((p: any) => {
                  const isDefault = p.name === (this.props as any).defaultProfile;
                  return (
                    <div
                      key={p.name}
                      className="term_menuOption"
                      onClick={() => this.handleShellProfileSelect(p)}
                      onContextMenu={(e) => this.handleRightClickProfile(e, p.name as string)}
                      title="Left-click to switch shell. Right-click to set as default."
                    >
                      {isDefault && <span className="term_activeStar">★</span>}
                      {p.name}
                    </div>
                  );
                })}
                <div className="term_menuDivider" />
                <div
                  className="term_menuOption term_webPaneOption"
                  onClick={this.handleWebPaneSelect}
                  onContextMenu={(e) => this.handleRightClickProfile(e, 'Web Pane')}
                  title="Left-click to switch to Web Pane. Right-click to set as default."
                >
                  {(this.props as any).defaultProfile === 'Web Pane' && <span className="term_activeStar">★</span>}
                  🌐 Web Pane
                </div>
              </>
            )}
          </div>
        )}
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

          .term_profileMenu {
            position: absolute;
            top: 24px;
            right: var(--space-8);
            min-width: 180px;
            background: var(--bg-secondary);
            border: 0.5px solid var(--border-neutral);
            border-radius: var(--radius-4);
            padding: var(--space-6) 0;
            z-index: 10000;
          }

          .term_menuTitle {
            padding: var(--space-4) var(--space-12) var(--space-6);
            font-size: 11px;
            font-weight: var(--weight-medium);
            color: var(--text-tertiary);
            border-bottom: 0.5px solid var(--border-neutral);
            margin-bottom: var(--space-4);
            user-select: none;
            font-family: var(--font-sans);
          }

          .term_menuOption {
            padding: var(--space-6) var(--space-12);
            font-size: 11px;
            color: var(--text-secondary);
            cursor: pointer;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            transition:
              background 0.15s ease,
              color 0.15s ease;
            font-family: var(--font-sans);
            font-weight: var(--weight-regular);
          }

          .term_menuOption:hover {
            background: var(--info-bg);
            color: var(--text-primary);
          }

          .term_menuOptionActive {
            color: var(--text-primary);
            font-weight: var(--weight-medium);
          }

          .term_activeStar {
            color: #0096ff;
            margin-right: var(--space-6);
            font-size: 10px;
          }

          .term_menuDivider {
            height: 0.5px;
            background: var(--border-neutral);
            margin: var(--space-4) 0;
          }

          .term_webPaneOption {
            color: var(--info-text);
            font-weight: var(--weight-medium);
          }

          .term_webPaneOption:hover {
            background: var(--info-bg);
            color: var(--text-primary);
          }

          .term_webPaneInputRow {
            display: flex;
            align-items: center;
            gap: var(--space-6);
            background: var(--bg-tertiary);
            border: 0.5px solid var(--border-neutral);
            border-radius: var(--radius-4);
            padding: var(--space-4) var(--space-8);
            margin: var(--space-4) var(--space-8);
          }

          .term_globeIcon {
            flex-shrink: 0;
            font-size: 12px;
          }

          .term_webPaneInput {
            flex: 1;
            background: transparent;
            border: none;
            outline: none;
            color: var(--text-primary);
            font-size: 11px;
            font-family: var(--font-sans);
            padding: var(--space-2) 0;
            min-width: 140px;
          }

          .term_webPaneInput::placeholder {
            color: var(--text-tertiary);
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

          .seeker_stats_row {
            color: var(--text-tertiary);
            font-size: 10px;
            margin-top: auto;
            padding-top: var(--space-10);
            border-top: 0.5px dashed var(--border-neutral);
            user-select: none;
          }
        `}</style>
      </div>
    );
  }
}

const mapStateToProps = (state: any) => ({
  defaultProfile: state.ui.defaultProfile,
  profiles: state.ui.profiles
    ? state.ui.profiles.asMutable
      ? // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        state.ui.profiles.asMutable({deep: true})
      : state.ui.profiles
    : []
});

const mapDispatchToProps = (dispatch: HyperDispatch, ownProps: WebPaneProps) => ({
  onClose() {
    dispatch(clearWebPane(ownProps.groupUid) as any);
  },
  onClosePane() {
    dispatch(userExitTermGroup(ownProps.groupUid) as any);
  },
  onSetTitle(title: string) {
    dispatch({type: 'TERM_GROUP_SET_WEB_NAME', uid: ownProps.groupUid, name: title} as any);
  },
  onSetUrl(url: string) {
    dispatch({type: 'TERM_GROUP_SET_WEB_URL', uid: ownProps.groupUid, url} as any);
  }
});

export default connect(mapStateToProps, mapDispatchToProps)(WebPane_);
