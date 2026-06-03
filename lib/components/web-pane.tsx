import React from 'react';

import {shell} from 'electron';
import {connect} from 'react-redux';

import type {HyperDispatch} from '../../typings/hyper';
import {clearWebPane, userExitTermGroup} from '../actions/term-groups';
import rpc from '../rpc';
import {countPathHorizontalStacks} from '../utils/term-groups';

import {PaneBand} from './pane-band';
import FindBar from './find-bar';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {ipcMain, ipcRenderer} = require('electron');

// Match a real Chrome UA so sites don't block the request
// Use the REAL Chromium UA, just stripped of the Electron + app product tokens.
// Keeping the genuine Chrome version keeps the UA consistent with the Sec-CH-UA
// client hints Chromium emits — a hardcoded/mismatched version trips Cloudflare/
// Wordfence bot checks, which 403 a site's /wp-content + /wp-includes assets and
// leave the page rendering bare (e.g. seths.blog).
const BROWSER_UA = (() => {
  const FALLBACK =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  try {
    let ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (!ua) return FALLBACK;
    // Drop "Electron/x.y.z" and the app product (Hyper/Hyperia/x.y.z).
    ua = ua.replace(/\s*(?:Electron|Hyper\w*)\/\S+/gi, '');
    const moz = ua.indexOf('Mozilla/');
    return (moz > 0 ? ua.slice(moz) : ua).replace(/\s{2,}/g, ' ').trim();
  } catch {
    return FALLBACK;
  }
})();

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

// Normalised key for de-duping history: lowercase scheme+host and strip trailing
// slashes off the path — so "x.com", "x.com/", and "https://x.com/" collapse to
// a single entry. Query + hash are kept (different ?q= are different pages).
const normalizeUrlKey = (u: string): string => {
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return u.trim().toLowerCase().replace(/\/+$/, '');
  }
};

// The site's own favicon (no third-party lookup). Used in history rows instead
// of the lock/security glyphs; falls back to a globe if it 404s.
const faviconForUrl = (u: string): string => {
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u);
    return `${parsed.protocol}//${parsed.host}/favicon.ico`;
  } catch {
    return '';
  }
};

const OAUTH_HOST_RE = /(^|\.)(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|github\.com\/login\/oauth|gitlab\.com\/users\/sign_in)/i;
const isOAuthUrl = (u: string): boolean => {
  if (!u) return false;
  try {
    const parsed = new URL(u);
    return OAUTH_HOST_RE.test(parsed.host) || OAUTH_HOST_RE.test(parsed.host + parsed.pathname);
  } catch {
    return false;
  }
};

const clickFnStr = `
  (function(searchText) {
    function isVisible(el) {
      if (!el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return true;
    }
    const cleanSearch = searchText.trim().toLowerCase();
    if (!cleanSearch) return { success: false, error: 'Empty search text' };
    const allElements = Array.from(document.querySelectorAll('*'));
    const matches = [];
    for (const el of allElements) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim().toLowerCase();
      if (text.includes(cleanSearch)) {
        matches.push(el);
      }
    }
    if (matches.length === 0) {
      return { success: false, error: 'No elements found containing text: ' + searchText };
    }
    const interactiveTags = ['button', 'a', 'input', 'select', 'textarea', 'option', 'summary'];
    function getScore(el) {
      let score = 0;
      const tagName = el.tagName.toLowerCase();
      if (interactiveTags.includes(tagName)) score += 100;
      if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') score += 100;
      if (el.onclick || el.getAttribute('onclick')) score += 50;
      const textLen = (el.textContent || '').trim().length;
      score -= (textLen - searchText.length) * 0.1;
      score += el.querySelectorAll('*').length === 0 ? 50 : 0;
      return score;
    }
    matches.sort((a, b) => getScore(b) - getScore(a));
    const target = matches[0];
    function triggerMouseEvent(node, eventType) {
      const clickEvent = new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        view: window
      });
      node.dispatchEvent(clickEvent);
    }
    try { target.focus(); } catch(e){}
    triggerMouseEvent(target, 'mouseover');
    triggerMouseEvent(target, 'mousedown');
    triggerMouseEvent(target, 'click');
    triggerMouseEvent(target, 'mouseup');
    if (typeof target.click === 'function') {
      target.click();
    }
    const rect = target.getBoundingClientRect();
    return {
      success: true,
      tagName: target.tagName,
      text: target.textContent ? target.textContent.trim().substring(0, 100) : '',
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    };
  })
`;

// Ghost-cursor mouse driver. Injected into the webview: spawns/moves a 👻 that
// GLIDES to (x, y) so the human can watch the agent move, then (for 'click')
// fires the full pointer/mouse event sequence on the element at that point.
// Returns a Promise so executeJavaScript waits for the glide before clicking.
const ghostMouseFnStr = `
  (function(x, y, action) {
    return new Promise(function(resolve) {
      try {
        var ID = '__hyperia_ghost__';
        var g = document.getElementById(ID);
        if (!g) {
          g = document.createElement('div');
          g.id = ID;
          g.textContent = '👻';
          g.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;font-size:30px;line-height:1;pointer-events:none;-webkit-user-select:none;transition:transform .42s cubic-bezier(.22,1,.36,1),opacity .3s;filter:drop-shadow(0 3px 5px rgba(0,0,0,.45));will-change:transform;';
          (document.body || document.documentElement).appendChild(g);
        }
        g.style.opacity = '1';
        // Anchor so the ghost's "head" hovers just above the target point.
        g.style.transform = 'translate(' + (x - 8) + 'px,' + (y - 30) + 'px)';

        function finish() {
          if (action !== 'click') {
            resolve({ success: true, action: 'move', x: x, y: y });
            return;
          }
          var el = document.elementFromPoint(x, y);
          try { g.animate([{opacity:1},{opacity:.35},{opacity:1}], {duration:200}); } catch (e) {}
          if (!el) { resolve({ success: false, error: 'No element at (' + x + ',' + y + ')' }); return; }
          var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
          ['pointerover','mouseover','pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t) {
            try { el.dispatchEvent(new MouseEvent(t, opts)); } catch (e) {}
          });
          try { if (typeof el.click === 'function') el.click(); } catch (e) {}
          var label = (el.tagName || '').toLowerCase() + (el.id ? '#' + el.id : '');
          resolve({ success: true, action: 'click', x: x, y: y, target: label, text: (el.textContent || '').trim().slice(0, 80) });
        }
        // Let the glide play out before clicking (purely a nice visual).
        setTimeout(finish, action === 'click' ? 440 : 0);
      } catch (e) {
        resolve({ success: false, error: String(e) });
      }
    });
  })
`;

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

  // Group key: scheme://host/<first-path-segment>. Collapses e.g. every
  // google.com/maps/@lat,lng,zoom URL under one "google.com/maps" root, so a
  // session that spammed many URLs (Maps, search) becomes one expandable entry.
  historyRootKey = (value: string): string => {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(value) ? value : 'https://' + value);
      const seg = u.pathname.split('/').filter(Boolean)[0] || '';
      return `${u.protocol}//${u.host}${seg ? '/' + seg : ''}`.toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  };

  highlightHistory = (text: string, q: string): React.ReactNode => {
    if (!q) return <span>{text}</span>;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return <span>{text}</span>;
    return (
      <span>
        {text.substring(0, idx)}
        <span style={{textDecoration: 'underline', textUnderlineOffset: '2px'}}>{text.substring(idx, idx + q.length)}</span>
        {text.substring(idx + q.length)}
      </span>
    );
  };

  // Flatten history into visible rows: URL entries sharing a root collapse into
  // one 'root' row; its children appear only when that root is expanded (or when
  // a search query is active, so matches are always visible).
  getHistoryVisibleRows = (
    query: string
  ): Array<
    {type: 'single' | 'child'; item: WebHistoryEntry} | {type: 'root'; key: string; label: string; entries: WebHistoryEntry[]}
  > => {
    const filtered = query
      ? this.state.webHistory.filter(
          (item) =>
            item.value.toLowerCase().includes(query) || (item.titleAtVisit && item.titleAtVisit.toLowerCase().includes(query))
        )
      : this.state.webHistory;
    const order: string[] = [];
    const groups: {[k: string]: WebHistoryEntry[]} = {};
    for (const item of filtered) {
      // AI queries never group — each is its own row.
      const key = item.kind === 'url' ? this.historyRootKey(item.value) : `__solo__${item.value}-${item.visitedAt}`;
      if (!groups[key]) {
        groups[key] = [];
        order.push(key);
      }
      groups[key].push(item);
    }
    const rows: Array<
      {type: 'single' | 'child'; item: WebHistoryEntry} | {type: 'root'; key: string; label: string; entries: WebHistoryEntry[]}
    > = [];
    for (const key of order) {
      const entries = groups[key];
      if (entries.length === 1) {
        rows.push({type: 'single', item: entries[0]});
      } else {
        rows.push({type: 'root', key, label: key.replace(/^https?:\/\//, ''), entries});
        if (this.state.expandedHistoryRoots[key] || !!query) {
          for (const item of entries) rows.push({type: 'child', item});
        }
      }
    }
    return rows;
  };

  renderHistoryRootRow = (
    row: {key: string; label: string; entries: WebHistoryEntry[]},
    index: number
  ): React.ReactNode => {
    const isFocused = index === this.state.navigatorFocusedIndex;
    const expanded = !!this.state.expandedHistoryRoots[row.key];
    const sample = row.entries[0];
    return (
      <div
        key={`root-${row.key}`}
        onClick={(e) => {
          e.stopPropagation();
          this.setState((s) => ({
            expandedHistoryRoots: {...s.expandedHistoryRoots, [row.key]: !s.expandedHistoryRoots[row.key]}
          }));
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
          style={{fontSize: '12px', color: 'var(--text-tertiary)', flexShrink: 0}}
          aria-hidden="true"
        />
        <span style={{position: 'relative', width: '14px', height: '14px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}>
          <i className="ti ti-world" style={{fontSize: '13px', color: isFocused ? 'var(--info-text)' : 'var(--text-tertiary)'}} aria-hidden="true" />
          <img
            src={faviconForUrl(sample.value)}
            width={14}
            height={14}
            alt=""
            style={{position: 'absolute', inset: 0, borderRadius: '2px', objectFit: 'contain'}}
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
        <span style={{fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)', flexShrink: 0, marginRight: 'var(--space-6)'}}>
          {row.entries.length}
        </span>
      </div>
    );
  };

  renderHistoryRow = (item: WebHistoryEntry, index: number, query: string, indent = false): React.ReactNode => {
    const isFocused = index === this.state.navigatorFocusedIndex;
    const isAiRow = item.kind === 'ai-query';
    return (
      <div
        key={`${item.value}-${item.visitedAt}`}
        onClick={(e) => {
          if (isAiRow) {
            const conversationId = item.conversationId || `conv-${Date.now()}`;
            if (e.shiftKey) {
              const newConvId = `conv-${Date.now()}`;
              this.createConversation(newConvId, item.value);
              const isCurrentPaneEmpty = !this.props.url || this.props.url === 'about:blank' || this.props.url === '';
              if (isCurrentPaneEmpty) {
                this.navigateWebview(`ai://${newConvId}`);
              } else {
                rpc.emit('split request vertical', {
                  activeUid: this.props.sessionUid || this.props.groupUid,
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
          padding: indent ? '5px 12px 5px 32px' : '6px 12px',
          cursor: 'pointer',
          background: isFocused ? 'var(--info-bg)' : undefined,
          transition: 'background 0.1s ease'
        }}
        className={isFocused ? 'term_navigatorDirRow_focused' : 'term_navigatorDirRow'}
      >
        {isAiRow ? (
          <i className="ti ti-sparkles" style={{fontSize: '13px', color: isFocused ? 'var(--info-text)' : 'var(--color-ai-purple, #7F77DD)', flexShrink: 0}} />
        ) : (
          <span style={{position: 'relative', width: '14px', height: '14px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}>
            <i className="ti ti-world" style={{fontSize: '13px', color: isFocused ? 'var(--info-text)' : 'var(--text-tertiary)'}} aria-hidden="true" />
            <img
              src={faviconForUrl(item.value)}
              width={14}
              height={14}
              alt=""
              style={{position: 'absolute', inset: 0, borderRadius: '2px', objectFit: 'contain'}}
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
            color: isFocused ? (isAiRow ? 'var(--color-ai-purple, #7F77DD)' : 'var(--info-text)') : 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            flex: 1
          }}
        >
          {item.titleAtVisit ? (
            <span style={{display: 'flex', alignItems: 'center', gap: 'var(--space-6)', minWidth: 0, maxWidth: '100%', overflow: 'hidden'}}>
              <span title={item.titleAtVisit} style={{fontWeight: 600, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0}}>
                {this.highlightHistory(item.titleAtVisit, query)}
              </span>
              <span title={item.value} style={{color: 'var(--text-tertiary)', fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1}}>
                {this.highlightHistory(item.value, query)}
              </span>
            </span>
          ) : (
            this.highlightHistory(item.value, query)
          )}
        </span>
        <div
          onClick={(e) => {
            e.stopPropagation();
            this.removeHistoryEntry(item.kind, item.value, item.visitedAt);
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
          <i className="ti ti-x" style={{fontSize: '10px'}} aria-hidden="true" />
        </div>
      </div>
    );
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
    const newHistory = this.state.webHistory.filter((item) => {
      if (item.kind === kind && item.value === value) {
        if (visitedAt === undefined || item.visitedAt === visitedAt) {
          return false;
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
      this.setState({
        isUrlNavigatorOpen: false
      });
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
                activeUid: this.props.sessionUid || this.props.groupUid,
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
                activeUid: this.props.sessionUid || this.props.groupUid,
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
      this.setState({loading: true, error: null, pageBgColor: null});
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
            "var h=document.head||document.documentElement;h.insertBefore(s,h.firstChild);}catch(e){}})()"
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
          // it. Close the URL navigator when the page takes focus.
          wc.on('focus', () => {
            if (this.state.isUrlNavigatorOpen) {
              this.setState({isUrlNavigatorOpen: false});
            }
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
        ).then((color: string) => {
          if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
            this.setState({pageBgColor: color});
          }
        }).catch(() => {});
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
        try { wv.stop(); } catch { /* ignore — webview may not be ready */ }
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
          rpc.emit('split request horizontal', {
            activeUid: this.props.sessionUid || this.props.groupUid,
            profile: 'Web Pane',
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
    menu.append(new MenuItem({label: 'New Note', click: () => void ipcMain.emit('new-sticky', {})}));
    menu.append(new MenuItem({type: 'separator'}));
    menu.append(new MenuItem({label: 'Close Tab', click: () => this.props.onClose?.()}));
    menu.popup();
    /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call */
  };

  handlePaneBandContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

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
        enabled: !this.state.isNarrow,
        click: () => {
          rpc.emit('split request vertical', {activeUid: this.props.sessionUid || this.props.groupUid, profile: 'picker'});
        }
      })
    );

    menu.append(
      new MenuItem({
        label: 'Split Down',
        accelerator: 'Ctrl+Shift+_',
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
        enabled: !this.state.isNarrow,
        click: () => {
          rpc.emit('split request vertical', {
            activeUid: this.props.sessionUid || this.props.groupUid,
            profile: (this.props as any).defaultProfile || undefined
          });
        }
      })
    );

    menu.append(
      new MenuItem({
        label: 'Clone Down',
        accelerator: 'Ctrl+Alt+Shift+_',
        enabled: !isSplitDownDisabled,
        click: () => {
          rpc.emit('split request horizontal', {
            activeUid: this.props.sessionUid || this.props.groupUid,
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
          const val = prompt('Enter pane name:', this.props.splitLabel ? `Pane ${this.props.splitLabel}` : 'Browser');
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

  renderUrlBreadcrumbs = () => {
    const {url} = this.props;
    const isAi = url && url.startsWith('ai://');
    const currentUrl = isAi ? 'AI Chat' : this.state.activeUrl || this.props.url || 'about:blank';

    if (isAi) {
      const conversationId = url.slice(5);
      const conv = this.state.aiConversations.find((c) => c.id === conversationId);
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
          <i className="ti ti-sparkles" style={{color: 'var(--color-ai-purple, #7F77DD)', marginRight: '4px'}} />
          <span>AI Chat</span>
          <span style={{color: 'var(--text-tertiary)'}}>&gt;</span>
          <span style={{color: 'var(--text-primary)'}}>{title}</span>
        </div>
      );
    }

    // Parse standard URL for breadcrumbs
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
      // invalid URL, ignore
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
          <i className="ti ti-world" style={{color: 'var(--info-text)', marginRight: '4px'}} />
          <span style={{color: 'var(--text-primary)', wordBreak: 'break-all', overflowWrap: 'anywhere', minWidth: 0}}>
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

    // Protocol hop
    hops.push({
      name: protocol,
      url: rootUrl,
      title: `Go to ${rootUrl}`
    });

    // Hostname REVERSED into filesystem order — news.ycombinator.com → com /
    // ycombinator / news. TLD first (the "website type"), then the domain name,
    // then the sub-domain(s). All host hops navigate to the site root.
    const hostParts = hostname.split('.').filter(Boolean);
    for (let i = hostParts.length - 1; i >= 0; i--) {
      hops.push({name: hostParts[i], url: rootUrl, title: `Go to ${rootUrl}`});
    }

    // Port hop (if any)
    if (port) {
      hops.push({
        name: `:${port}`,
        url: `${protocol}://${hostname}:${port}`,
        title: `Go to ${protocol}://${hostname}:${port}`
      });
    }

    // Path segments — directories, then the end file. Each navigates to its prefix.
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

    // Fragment (#…) as its own end segment.
    if (hash) {
      hops.push({name: hash, url: currentUrl, title: `Fragment ${hash}`});
    }

    // Query VARIABLES — list the KEYS only (the values are noise and they're what
    // overflowed the bar). Rendered after a "?" as a dimmed, non-navigable group.
    const varKeys: string[] = [];
    if (search) {
      try {
        for (const k of new URLSearchParams(search).keys()) {
          if (k && !varKeys.includes(k)) varKeys.push(k);
        }
      } catch (e) {
        /* malformed query string — skip */
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
            this.navigateWebview(rootUrl);
            this.setState({isUrlNavigatorOpen: false});
          }}
          style={{cursor: 'pointer', display: 'inline-flex', alignItems: 'center', color: 'var(--text-secondary)'}}
          title={`Go to root site: ${rootUrl}`}
        >
          <i className="ti ti-world" style={{fontSize: '13px'}} aria-hidden="true" />
        </span>
        {hops.map((hop, index) => {
          const isLast = index === hops.length - 1;
          return (
            <React.Fragment key={index}>
              <span style={{fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)'}}>/</span>
              {isLast ? (
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-primary)',
                    fontWeight: 500,
                    fontFamily: 'var(--font-mono)',
                    // The last hop carries the (often huge) query string — let it
                    // wrap mid-token instead of spanning off the page.
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
                    this.navigateWebview(hop.url);
                    this.setState({isUrlNavigatorOpen: false});
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
            <span style={{fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginLeft: '2px'}}>?</span>
            {varKeys.map((k, vi) => (
              <React.Fragment key={'var-' + vi}>
                {vi > 0 && (
                  <span style={{fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', opacity: 0.6}}>·</span>
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

  renderUrlNavigatorFooter = () => {
    const {url} = this.props;
    const isAi = url && url.startsWith('ai://');
    const val = this.state.navigatorInputVal;
    const query = val.toLowerCase();

    const filtered = isAi
      ? query
        ? this.state.aiConversations.filter((c) => c.title.toLowerCase().includes(query))
        : this.state.aiConversations
      : query
        ? this.state.webHistory.filter((item) => item.value.toLowerCase().includes(query))
        : this.state.webHistory;

    const isTyping = val !== (isAi ? '' : this.state.activeUrl || this.props.url || '');

    let statusText = '';
    let statusColor = 'var(--text-tertiary)';

    if (isTyping && val.trim()) {
      const trimmed = val.trim();
      const isUrl = this.isInputUrl(trimmed);
      const hasAi = this.state.hasAiConfigured;

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

    const handleGo = () => {
      const idx = this.state.navigatorFocusedIndex;
      const filteredList = isAi
        ? query
          ? this.state.aiConversations.filter((c) => c.title.toLowerCase().includes(query))
          : this.state.aiConversations
        : query
          ? this.state.webHistory.filter((item) => item.value.toLowerCase().includes(query))
          : this.state.webHistory;

      if (idx >= 0 && idx < filteredList.length) {
        const item = filteredList[idx] as any;
        if (item.kind === 'ai-query') {
          const conversationId = item.conversationId || `conv-${Date.now()}`;
          this.navigateWebview(`ai://${conversationId}`);
        } else {
          const val = (item as any).value || (item as any).title;
          if ((item as any).id) {
            this.navigateWebview(`ai://${(item as any).id}`);
          } else {
            this.navigateWebview(val);
          }
        }
      } else {
        const trimmed = val.trim();
        if (trimmed) {
          const isUrl = this.isInputUrl(trimmed);
          if (isUrl) {
            let finalUrl = trimmed;
            if (!/^https?:\/\//i.test(finalUrl)) {
              if (/^(localhost|127\.0\.0\.1)/i.test(finalUrl)) {
                finalUrl = 'http://' + finalUrl;
              } else {
                finalUrl = 'https://' + finalUrl;
              }
            }
            this.navigateWebview(finalUrl);
          } else {
            if (!this.state.hasAiConfigured) {
              this.setState({navigatorError: 'AI not configured — please check settings'});
              return;
            }
            const conversationId = 'conv-' + Date.now();
            this.createConversation(conversationId, trimmed);
            this.navigateWebview(`ai://${conversationId}`);
          }
        }
      }
      this.setState({isUrlNavigatorOpen: false});
    };

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
        {/* Input row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-8)',
            padding: 'var(--space-8) var(--space-12)',
            boxSizing: 'border-box'
          }}
        >
          {this.state.loading && url ? (
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
            ref={this.navigatorInputRef}
            type="text"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontSize: '11px',
              fontFamily: isAi || (val.trim() && !this.isInputUrl(val)) ? 'var(--font-sans)' : 'var(--font-mono)',
              height: '24px',
              padding: 0
            }}
            placeholder={isAi ? 'Search threads or ask a new question...' : 'Search history or type URL... (Esc to close)'}
            value={this.state.navigatorInputVal}
            onContextMenu={(e) => {
              // Right-click the URL/search field → standard edit menu (Paste etc.).
              e.preventDefault();
              e.stopPropagation();
              try {
                this.navigatorInputRef.current?.focus();
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
              const newQuery = newVal.toLowerCase();
              this.setState({
                navigatorInputVal: newVal,
                navigatorFocusedIndex: -1,
                navigatorError: null
              });
            }}
            onKeyDown={this.handlePopupKeyDown}
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

        {/* Helper/Status bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '4px 12px 6px 12px',
            fontSize: '9px',
            color: statusColor,
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
            style={{display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', marginRight: '12px'}}
            title={this.state.saveHistory ? "History saving is enabled" : "History saving is disabled (Private mode)"}
          >
            <span style={{fontSize: '9px', color: 'var(--text-secondary)'}}>Save History</span>
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
                checked={this.state.saveHistory}
                onChange={this.toggleSaveHistory}
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
                  backgroundColor: this.state.saveHistory ? 'var(--text-info, #007aff)' : 'var(--bg-tertiary, #3e3e3f)',
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
                  left: this.state.saveHistory ? '13px' : '2px',
                  bottom: '2px',
                  backgroundColor: '#ffffff',
                  borderRadius: '50%',
                  transition: 'left 0.2s ease-in-out',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
                }}
              />
            </label>
          </div>

          <span style={{color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)'}}>
            Esc to close
          </span>
        </div>
      </div>
    );
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
    // Cap the toolbar title — page titles run long ("… Recipe From Scratch -
    // Budget Bytes") and PaneBand renders nowrap + no-shrink, so the full title
    // spans the whole bar. Trim to a reasonable length with an ellipsis.
    const rawWebName = (this.props as any).webName as string | undefined;
    const webNameShort =
      rawWebName && rawWebName.length > 32 ? `${rawWebName.slice(0, 31).trimEnd()}…` : rawWebName;
    const labelText = isAi ? 'ask' : webNameShort || (splitLabel ? `Pane ${splitLabel}` : 'Browser');

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
    const hideSplits = w < 400;
    const showUrlBar = w >= 320;

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
            isSplitRightDisabled={hideSplits}
            isSplitDownDisabled={isSplitDownDisabled || hideSplits}
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
                        const { shell } = require('electron');
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
                      <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>Open in system browser</div>
                    </div>
                  </span>
                )}
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
                      <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>New sticky from page</div>
                      <div style={{fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginTop: 'var(--space-2)'}}>
                        Title + URL + selection/extract
                      </div>
                    </div>
                  </span>
                )}
              </div>
            }
            locationBar={showUrlBar ? (
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
                        navigatorLeft = (rect.right - parentRect.left) - widthToUse;
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
                  minWidth: '110px',
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
                      color: isAi
                        ? 'var(--color-ai-purple, #7F77DD)'
                        : 'var(--info-text)',
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
            ) : null}
            onSplitRight={() => rpc.emit('split request vertical', {activeUid: this.props.sessionUid || this.props.groupUid, profile: 'picker'})}
            onSplitDown={() => rpc.emit('split request horizontal', {activeUid: this.props.sessionUid || this.props.groupUid})}
            onClose={() => {
              if (hasSession) {
                onClose?.();
              } else {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                (this.props as any).onClosePane();
              }
            }}
            onContextMenu={this.handlePaneBandContextMenu}
            height={isAi ? 'normal' : 'compact'}
          />
        )}

        {this.state.isUrlNavigatorOpen && (
          <div
            ref={this.urlNavigatorRef}
            style={{
              position: 'absolute',
              top: `${this.state.navigatorTop ?? 38}px`,
              left: `${this.state.navigatorLeft ?? 8}px`,
              width: `${this.state.navigatorWidth ?? 320}px`,
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
            {this.renderUrlBreadcrumbs()}

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
                const isInitialUrl =
                  this.state.navigatorInputVal === this.state.activeUrl ||
                  this.state.navigatorInputVal === this.props.url;
                const query = isInitialUrl ? '' : this.state.navigatorInputVal.toLowerCase().trim();

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

                  return (
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
                        {filtered.length > 0 && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm('Clear all AI conversation threads?')) {
                                this.clearAllAiConversations();
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
                      {filtered.length === 0 ? (
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
                        filtered.map((item, index) => {
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
                                {highlightMatch(item.title, query)}
                              </span>
                              <div
                                onClick={(e) => {
                                  e.stopPropagation();
                                  this.removeAiConversation(item.id);
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
                                <i className="ti ti-x" style={{fontSize: '10px'}} aria-hidden="true" />
                              </div>
                            </div>
                          );
                        })
                      )}
                    </>
                  );
                }

                const rows = this.getHistoryVisibleRows(query);

                return (
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
                              this.clearAllHistory();
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
                          ? this.renderHistoryRootRow(row, index)
                          : this.renderHistoryRow(row.item, index, query, row.type === 'child')
                      )
                    )}
                  </>
                );
              })()}
            </div>

            {/* Footer: Search/URL input entry bar */}
            {this.renderUrlNavigatorFooter()}
          </div>
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
                // Without this, the guest can't request new windows, so
                // target="_blank"/window.open is silently blocked BEFORE the
                // main-process window-open handler runs — and the "split down +
                // open in a new pane" never fires. Enabling it lets that handler
                // intercept the popup and route it to a split.
                {...({allowpopups: 'true'} as any)}
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
  onSetTitle(title: string) {
    dispatch({type: 'TERM_GROUP_SET_WEB_NAME', uid: ownProps.groupUid, name: title} as any);
  },
  onSetUrl(url: string) {
    dispatch({type: 'TERM_GROUP_SET_WEB_URL', uid: ownProps.groupUid, url} as any);
  },
  onActive() {
    dispatch({type: 'TERM_GROUP_SET_ACTIVE', uid: ownProps.groupUid} as any);
  }
});

export default connect(mapStateToProps, mapDispatchToProps)(WebPane_);
