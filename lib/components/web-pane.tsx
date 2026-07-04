import {shell} from 'electron';
import React from 'react';

import {connect} from 'react-redux';

import type {HyperDispatch} from '../../typings/hyper';
import {clearWebPane, userExitTermGroup, splitWebPane, popOutPane} from '../actions/term-groups';
import {markTabBell, clearTabBell} from '../actions/ui';
import rpc from '../rpc';
import {toNavigableUrl} from '../utils/navigable-url';
import {countPathHorizontalStacks} from '../utils/term-groups';
import {
  getSecurityState,
  normalizeUrlKey,
  stripUrlQuery,
  faviconForUrl,
  isOAuthUrl,
  isValidUrl
} from '../utils/web-pane-helpers';
import {clickFnStr, ghostMouseFnStr} from '../utils/webview-scripts';

import {AskAiView} from './ask-ai-view';
import FindBar from './find-bar';
import {PaneBand} from './pane-band';
import {activeTerminals} from './term';
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
  // True when this pane's ROOT term group is the active tab (mapped from redux).
  isTabActive?: boolean;
  // Standard tab-bell plumbing (ui.bellMarkers — the same store terminal BELs use).
  onTabBell?: (uid: string) => void;
  onTabBellClear?: (uid: string) => void;
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
  // Freeze-swap still shown in place of the (hidden) native view while an
  // occluding DOM overlay is open. null = live view visible.
  frozenShot?: string | null;
  // True only after the cursor has DWELLED on the pane header (see
  // HEADER_HOVER_DWELL_MS) — hides the native view so the header's hover
  // tooltips (DOM, which a native view would otherwise occlude) are visible
  // over a frozen frame. Deliberately NOT set on transient mouse passes: a
  // freeze-swap on every header crossing made the pane flash constantly while
  // simply mousing in/out of it.
  headerHover?: boolean;
  // Whether this pane is actually in the viewport (IntersectionObserver). An
  // inactive tab is parked off-screen, so its native view must be hidden.
  onScreen?: boolean;
  // Find-in-page (Ctrl+F) bar.
  findOpen: boolean;
  findText: string;
  findActive: number;
  findTotal: number;
  // Native WebContentsView zoom (owned in main; mirrored here for +/- math).
  zoomFactor: number;
  // Which collapsed history roots (e.g. all "google.com/maps" URLs) are expanded.
  expandedHistoryRoots: {[key: string]: boolean};
}

// net error codes where the site couldn't be reached → fall back to a DDG search:
// ERR_NAME_NOT_RESOLVED, ERR_NAME_RESOLUTION_FAILED, ERR_ADDRESS_UNREACHABLE, ERR_INVALID_URL.
const DDG_RESOLVE_FAIL = new Set([-105, -137, -109, -300]);

// How long the cursor must REST on the pane header before the native view is
// frozen+hidden to reveal the header's DOM tooltips. Transient passes (mousing
// out of the pane across the header, moving to another pane/tab) never trigger
// the swap — hiding on every crossing made web panes flash constantly.
const HEADER_HOVER_DWELL_MS = 350;

class WebPane_ extends React.PureComponent<WebPaneProps, WebPaneState> {
  // Geometry anchor for the native WebContentsView (main-process owned). The
  // native view paints OVER this div; we only read its rect to position it.
  bodyRef = React.createRef<HTMLDivElement>();
  urlInputRef = React.createRef<HTMLInputElement>();
  urlNavigatorRef = React.createRef<HTMLDivElement>();
  urlBarRef = React.createRef<HTMLDivElement>();
  navigatorInputRef = React.createRef<HTMLInputElement>();
  findInputRef = React.createRef<HTMLInputElement>();
  webWrapperRef = React.createRef<HTMLDivElement>();
  resizeObserver: any = null;
  _windowKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  _findHandler: ((e: any, payload: {uid: string}) => void) | null = null;
  _openSplitHandler: ((e: any, payload: {uid: string; url: string}) => void) | null = null;
  _focusHandler: ((e: any, payload: {uid: string}) => void) | null = null;
  _frozenHandler: ((e: any, payload: {uid: string; shot: string | null}) => void) | null = null;
  _zoomKeyHandler: ((e: any, payload: {uid: string; dir: 'in' | 'out' | 'reset'}) => void) | null = null;
  // requestAnimationFrame token so reportBounds fires at most once per frame.
  _boundsRaf: number | null = null;
  _onScroll: (() => void) | null = null;
  // IntersectionObserver drives instant show/hide on tab switch (the pane leaves
  // the viewport). A low-frequency poll remains as a safety net for the rare case
  // where a pane is repositioned (sibling closes) without a resize/scroll/IO event.
  _io: IntersectionObserver | null = null;
  _boundsInterval: ReturnType<typeof setInterval> | null = null;
  // web-pane:* main→renderer listeners (registered in mount, removed in unmount).
  _stateHandler: ((e: any, payload: any) => void) | null = null;
  _foundHandler: ((e: any, payload: any) => void) | null = null;
  _domReadyHandler: ((e: any, payload: any) => void) | null = null;
  // Pending header-hover dwell (freeze-swap only fires after the cursor rests).
  _headerHoverTimer: ReturnType<typeof setTimeout> | null = null;
  // ── Background-tab notify for the agent shell pane ───────────────────────
  // Last <title> the shell page reported (null until the first push) and a
  // burst guard so rapid-fire title ticks ring at most once per window.
  _lastShellTitle: string | null = null;
  _lastShellBellAt = 0;
  // True while OUR group-uid bell marker is set (cleared on tab activation).
  _bellPending = false;
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
    // Scrub query strings off previously-saved entries and collapse the former
    // ?-variants (history is query-less going forward).
    {
      const seen = new Set<string>();
      webHistory = webHistory.filter((e) => {
        if (e.kind !== 'url' || !e.value) return true;
        e.value = stripUrlQuery(e.value);
        const k = normalizeUrlKey(e.value);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
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
      frozenShot: null,
      headerHover: false,
      onScreen: true,
      findOpen: false,
      findText: '',
      findActive: 0,
      findTotal: 0,
      zoomFactor: 1,
      expandedHistoryRoots: {}
    };
  }

  labelRef = React.createRef<HTMLDivElement>();
  inputRef = React.createRef<HTMLInputElement>();

  // True when this pane hosts a real web page (native WebContentsView), i.e.
  // NOT an ai:// thread and NOT the empty-url seeker. Only those get a native
  // view; ai/seeker render pure DOM the native view must not occlude.
  isNativeWeb = (url = this.props.url): boolean => !!url && !url.startsWith('ai://');

  // Push the current pixel rect of bodyRef to main so it can position the native
  // view. Hidden while the URL navigator / find bar is open (so those DOM
  // overlays aren't occluded) or on an error screen. Coalesced to one send/frame.
  reportBounds = () => {
    if (this._boundsRaf != null) return;
    this._boundsRaf = requestAnimationFrame(() => {
      this._boundsRaf = null;
      const el = this.bodyRef.current;
      if (!el) return; // ai/seeker branch — no native view to place.
      const rect = el.getBoundingClientRect();
      const hasSize = rect.width > 0 && rect.height > 0;
      // IntersectionObserver tells us if the pane is actually in the viewport —
      // an inactive tab is parked at left:-9999em (still has size), so the rect
      // check alone can't detect it.
      const inViewport = this.state.onScreen !== false;
      const overlayHidden = this.state.isUrlNavigatorOpen || this.state.findOpen || this.state.headerHover;
      const showable = hasSize && inViewport && !this.state.error;
      const visible = showable && !overlayHidden;
      // Freeze (capture a still) ONLY when hiding an on-screen pane for a DOM
      // overlay — a tab-switch hide is off-screen and needs no capture.
      const freeze = showable && overlayHidden;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        ipcRenderer.send('web-pane:set-bounds', {
          uid: this.props.groupUid,
          bounds: {x: rect.left, y: rect.top, width: rect.width, height: rect.height},
          visible,
          freeze
        });
      } catch {
        /* main not ready */
      }
    });
  };

  reloadWebview = (hard: boolean) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    ipcRenderer.send('web-pane:nav', {
      uid: this.props.groupUid,
      action: hard ? 'reloadIgnoringCache' : 'reload'
    });
  };

  // Open the current page in the system browser (Chrome). The reliable bail-out
  // when an embedded view can't clear a bot wall (Cloudflare et al.).
  openInExternal = () => {
    const u = this.state.activeUrl || this.props.url || this.state.urlInputVal || '';
    if (/^https?:\/\//i.test(u)) {
      try {
        shell.openExternal(u);
      } catch (err) {
        console.error('openExternal failed:', err);
      }
    }
  };

  // Run JS in the native view and resolve with its (serializable) value, or
  // REJECT on failure — so callers can keep the old executeJavaScript
  // .then/.catch shape. Replaces the removed <webview>.executeJavaScript.
  execInPage = async (code: string): Promise<any> => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const res = await ipcRenderer.invoke('web-pane:execute-js', {uid: this.props.groupUid, code});
    if (res && res.ok) return res.result;
    throw new Error((res && res.error) || 'execute-js failed');
  };

  // Sample the page's background color so the pane ground matches it (avoids the
  // black-flash-between-repaints). Best-effort; failures are ignored.
  probePageBgColor = () => {
    this.execInPage(
      "(function(){try{var pick=function(el){if(!el)return '';var c=getComputedStyle(el).backgroundColor;return (c&&c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')?c:'';};return pick(document.body)||pick(document.documentElement)||'#ffffff';}catch(e){return '';}})()"
    )
      .then((color: string) => {
        if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
          this.setState({pageBgColor: color});
        }
      })
      .catch(() => {});
  };

  // Surface a bad HTTP status ("404") in the pane label instead of a meaningless
  // split letter, and drop the entry from history.
  probeHttpStatus = () => {
    this.execInPage(
      "(function(){try{var entries=performance.getEntriesByType('navigation');return entries.length?entries[0].responseStatus:0;}catch(e){return 0;}})()"
    )
      .then((httpStatus: number) => {
        if (httpStatus === 404 || httpStatus >= 400) {
          this.setState({httpStatus});
          const currentUrl = this.state.activeUrl;
          if (currentUrl) this.removeHistoryEntry('url', currentUrl);
        }
      })
      .catch(() => {});
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      ipcRenderer.send('web-pane:nav', {uid: this.props.groupUid, action: 'back'});
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      ipcRenderer.send('web-pane:nav', {uid: this.props.groupUid, action: 'forward'});
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
    // Drive the native view DIRECTLY too — clicking a URL-picker history row only
    // went through the redux/prop round-trip, which could be a no-op (props.url
    // didn't always change → componentDidUpdate's nav never fired), so the click
    // appeared to do nothing.
    if (!targetUrl.startsWith('ai://')) {
      const full = /^[a-z]+:\/\//i.test(targetUrl) ? targetUrl : 'https://' + targetUrl;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      ipcRenderer.send('web-pane:nav', {uid: this.props.groupUid, action: 'load', url: full});
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
    // History stores query-less URLs — "?tracking=junk" variants never land.
    if (kind === 'url') value = stripUrlQuery(value);
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
    // INSIDE the native view don't reach this document — those are handled by
    // the web-pane:focus push from the manager.)
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
      // Native-view lifecycle: create when this pane BECOMES a web page, tear it
      // down when it stops being one, and re-navigate when the url changes while
      // it stays a web page. (ai:// / empty-url panes never own a native view.)
      const wasNative = this.isNativeWeb(prevProps.url);
      const isNative = this.isNativeWeb(this.props.url);
      if (isNative && !wasNative) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        ipcRenderer.send('web-pane:create', {uid: this.props.groupUid, url: this.props.url});
        this.reportBounds();
      } else if (isNative && wasNative) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        ipcRenderer.send('web-pane:nav', {uid: this.props.groupUid, action: 'load', url: this.props.url});
      } else if (!isNative && wasNative) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        ipcRenderer.send('web-pane:destroy', {uid: this.props.groupUid});
      }

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

    // Hiding the native view (or laying it out) depends on these — re-push bounds
    // whenever they flip so the view is hidden behind the URL/find overlays.
    if (
      prevState.isUrlNavigatorOpen !== this.state.isUrlNavigatorOpen ||
      prevState.findOpen !== this.state.findOpen ||
      prevState.error !== this.state.error ||
      prevState.headerHover !== this.state.headerHover
    ) {
      this.reportBounds();
    }

    // The human switched TO this pane's tab → the shell-update bell has served
    // its purpose (mirror of SESSION_SET_ACTIVE clearing terminal bells).
    if (!prevProps.isTabActive && this.props.isTabActive) {
      this.clearPendingBell();
      // Self-heal: re-assert the native view on activation. If it's alive,
      // createPane is a no-op (cancels any pending teardown); if it was
      // reaped (window close, delayed-destroy, crash-restore, or dedupe
      // focusing a re-keyed group), it rebuilds — fixing the blank
      // Hyperia Agent tab you couldn't even right-click.
      if (this.isNativeWeb()) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        ipcRenderer.send('web-pane:create', {uid: this.props.groupUid, url: this.props.url});
        requestAnimationFrame(() => this.reportBounds());
      }
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
        // Pane resized → reposition the native view over its new rect.
        this.reportBounds();
      });
      this.resizeObserver.observe(this.webWrapperRef.current);
    }

    // Instant show/hide when this pane's tab is (de)activated — it leaves/enters
    // the viewport (parked at left:-9999em), which no resize/scroll event reports.
    if (this.bodyRef.current) {
      this._io = new IntersectionObserver(
        (entries) => {
          const e = entries[0];
          const vis = !!e && e.isIntersecting && e.intersectionRatio > 0;
          if (vis !== this.state.onScreen) this.setState({onScreen: vis});
          this.reportBounds();
        },
        {threshold: 0}
      );
      this._io.observe(this.bodyRef.current);
    }

    // Safety net for reposition-without-resize (a sibling split closes and this
    // pane slides over at the same size).
    this._boundsInterval = setInterval(this.reportBounds, 300);

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

    // ── Native WebContentsView wiring ────────────────────────────────────────
    // The page now lives in a main-process WebContentsView (app/web-pane-manager.ts).
    // We (1) ask main to create it, (2) push its geometry, and (3) subscribe to the
    // web-pane:* state pushes that replace the old <webview> DOM events.
    if (this.isNativeWeb()) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      ipcRenderer.send('web-pane:create', {uid: this.props.groupUid, url: this.props.url});
      // First bounds push after the layout has painted this frame.
      requestAnimationFrame(() => this.reportBounds());
    }

    // Page state pushed from main (partial — only changed fields present). Maps
    // onto the same state the old <webview> events fed.
    this._stateHandler = (_e: any, payload: any) => {
      if (!payload || payload.uid !== this.props.groupUid) return;

      // Sentinel from sidecar-served pages (agent config "Back"): swap this web
      // pane back into a new-pane picker. Never recorded in history.
      if (typeof payload.url === 'string' && payload.url.includes('#hyperia-back')) {
        rpc.emit('new', {
          isNewGroup: false,
          activeUid: this.props.sessionUid || undefined,
          profile: 'picker',
          groupUid: this.props.groupUid
        } as any);
        setTimeout(() => this.props.onClose?.(), 250);
        return;
      }

      const prevActiveUrl = this.state.activeUrl;
      const patch: Partial<WebPaneState> = {};

      if ('loading' in payload) {
        patch.loading = !!payload.loading;
        // did-start-loading equivalent: reset per-load derived state.
        if (payload.loading) {
          patch.error = null;
          patch.httpStatus = null;
          patch.pageBgColor = null;
        }
      }
      if ('canGoBack' in payload) patch.canGoBack = !!payload.canGoBack;
      if ('canGoForward' in payload) patch.canGoForward = !!payload.canGoForward;

      if ('title' in payload && payload.title) {
        this.props.onSetTitle?.(payload.title);
        // Agent shell pane finished a turn in a background tab → tab bell.
        this.maybeBellOnShellUpdate(String(payload.title));
      }

      let navigatedUrl: string | null = null;
      if ('url' in payload && typeof payload.url === 'string') {
        patch.activeUrl = payload.url;
        // Don't clobber what the user is typing into the URL bar.
        if (!this.state.isEditingUrl) patch.urlInputVal = payload.url;
        navigatedUrl = payload.url;
      }

      // did-fail-load equivalent.
      let failUrl: string | null = null;
      let failCode: number | null = null;
      if ('error' in payload) {
        if (payload.error) {
          patch.loading = false;
          patch.error = payload.error.description || 'Failed to load';
          failUrl = payload.error.url || this.state.urlInputVal || '';
          failCode = typeof payload.error.code === 'number' ? payload.error.code : null;
        } else {
          patch.error = null;
        }
      }

      const loadFinished = 'loading' in payload && payload.loading === false && !payload.error;

      this.setState(patch as any, () => {
        // Record history for a genuinely new main-frame URL (matches the old
        // did-navigate behavior: append to webHistory/localStorage + persist the
        // LIVE url into redux so it survives a remount when a sibling pane closes).
        if (navigatedUrl && navigatedUrl !== 'about:blank' && navigatedUrl !== prevActiveUrl) {
          this.addToHistory('url', navigatedUrl);
          if (navigatedUrl !== this.props.url) this.props.onSetUrl?.(navigatedUrl);
        }
        // On failure: drop the bad entry, and DDG-fallback an unresolved host.
        if (failUrl) {
          this.removeHistoryEntry('url', failUrl);
          if (
            failCode != null &&
            DDG_RESOLVE_FAIL.has(failCode) &&
            !/duckduckgo\.com\/\?q=/i.test(failUrl)
          ) {
            const q = failUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
            this.navigateWebview('https://duckduckgo.com/?q=' + encodeURIComponent(q));
          }
        }
        // Load complete → probe page bg color + HTTP status (old did-stop-loading).
        if (loadFinished) {
          this.probePageBgColor();
          this.probeHttpStatus();
        }
      });
    };
    ipcRenderer.on('web-pane:state', this._stateHandler);

    // Find-in-page match counts.
    this._foundHandler = (_e: any, payload: any) => {
      if (!payload || payload.uid !== this.props.groupUid) return;
      this.setState({
        findActive: typeof payload.active === 'number' ? payload.active : 0,
        findTotal: typeof payload.total === 'number' ? payload.total : 0
      });
    };
    ipcRenderer.on('web-pane:found-in-page', this._foundHandler);

    // dom-ready → slim-scrollbar inject + bg-color probe (main can't observe the
    // guest's dom-ready, so it relays the event and we run the JS via execute-js).
    this._domReadyHandler = (_e: any, payload: any) => {
      if (!payload || payload.uid !== this.props.groupUid) return;
      // Slim scrollbars, but only as a DEFAULT the page can override: prepend a
      // <style> at the very top of <head> so the page's own scrollbar rules win.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      void ipcRenderer.invoke('web-pane:execute-js', {
        uid: this.props.groupUid,
        code:
          "(function(){try{var ID='__hyperia_slim_sb__';if(document.getElementById(ID))return;" +
          "var s=document.createElement('style');s.id=ID;" +
          "s.textContent='::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(128,128,128,.45);border-radius:6px}::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.7)}';" +
          'var h=document.head||document.documentElement;h.insertBefore(s,h.firstChild);}catch(e){}})()'
      }).catch(() => {});
      this.probePageBgColor();
      // In-page input concerns (zoom shortcuts, OAuth redirect bail-out, focus →
      // pane activation) are wired on the native webContents in
      // app/web-pane-manager.ts and relayed here over web-pane:* IPC.
    };
    ipcRenderer.on('web-pane:dom-ready', this._domReadyHandler);

    // Keep the native view glued to bodyRef during window resizes and any
    // scroll that shifts the pane within the layout.
    this._onScroll = () => this.reportBounds();
    document.addEventListener('scroll', this._onScroll, true);

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

    // Listen for reload requests from the tab right-click menu.
    this._reloadHandler = (uid: string) => {
      if (uid === this.props.groupUid) this.reloadWebview(false);
    };
    rpc.on('web-pane-reload', this._reloadHandler);

    // Right-click "Find in page" → the manager sends this (keyed by pane uid).
    this._findHandler = (_e: any, payload: {uid: string}) => {
      if ((payload as any)?.uid !== this.props.groupUid) return;
      this.setState({findOpen: true});
    };
    ipcRenderer.on('web-pane:find-open', this._findHandler);

    // target="_blank" / window.open in the page → the manager routes it here
    // (keyed by pane uid) so we split a new web pane BELOW this one.
    this._openSplitHandler = (_e: any, payload: {uid: string; url: string}) => {
      if (payload?.uid !== this.props.groupUid || !payload.url) return;
      this.props.onSplitWebPane?.(payload.url, 'HORIZONTAL');
    };
    ipcRenderer.on('web-pane:open-split', this._openSplitHandler);

    // Clicking into the page focuses the native view — activate this pane and
    // dismiss the URL navigator (the DOM can't see clicks inside the view).
    this._focusHandler = (_e: any, payload: {uid: string}) => {
      if (payload?.uid !== this.props.groupUid) return;
      this.props.onActive?.();
      if (this.state.isUrlNavigatorOpen) this.setState({isUrlNavigatorOpen: false});
    };
    ipcRenderer.on('web-pane:focus', this._focusHandler);

    // Freeze-swap: while the native view is hidden (URL navigator / find bar
    // open), main hands us a still of the last live frame to paint in its place
    // instead of white. Cleared (null) when the view comes back.
    this._frozenHandler = (_e: any, payload: {uid: string; shot: string | null}) => {
      if (payload?.uid !== this.props.groupUid) return;
      this.setState({frozenShot: payload.shot});
    };
    ipcRenderer.on('web-pane:frozen', this._frozenHandler);

    this._clickHandler = (data: {uid: string; text?: string; selector?: string}) => {
      if (data.uid !== this.props.groupUid) return;
      let code: string | null = null;
      if (data.selector) {
        code = `
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
      } else if (data.text) {
        code = `
            (${clickFnStr})(${JSON.stringify(data.text)})
          `;
      }
      if (!code) return;
      this.execInPage(code)
        .then((result: any) => {
          rpc.emit('web-pane-click-result', {uid: data.uid, result});
        })
        .catch((err: any) => {
          rpc.emit('web-pane-click-result', {uid: data.uid, result: {success: false, error: err.message}});
        });
    };
    rpc.on('web-pane-click', this._clickHandler);

    // Read the CURRENT page: live URL + title + visible text. Lets the agent
    // see what page the user actually navigated to (the opened URL goes stale)
    // and extract its content without re-fetching.
    this._readHandler = (data: {uid: string}) => {
      if (data.uid !== this.props.groupUid) return;
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
      this.execInPage(code)
        .then((result: any) => {
          rpc.emit('web-pane-read-result', {uid: data.uid, result});
        })
        .catch((err: any) => {
          rpc.emit('web-pane-read-result', {uid: data.uid, result: {success: false, error: err.message}});
        });
    };
    rpc.on('web-pane-read', this._readHandler);

    // Inject + run arbitrary JS in the page, return its (serializable) value.
    this._evalHandler = (data: {uid: string; js: string}) => {
      if (data.uid !== this.props.groupUid) return;
      this.execInPage(data.js)
        .then((value: any) => {
          rpc.emit('web-pane-eval-result', {uid: data.uid, result: {success: true, value}});
        })
        .catch((err: any) => {
          rpc.emit('web-pane-eval-result', {uid: data.uid, result: {success: false, error: err.message}});
        });
    };
    rpc.on('web-pane-eval', this._evalHandler);

    // Move / click at a pixel coordinate, with the 👻 ghost cursor gliding there
    // so the human can watch the agent act on the page.
    this._mouseHandler = (data: {uid: string; x: number; y: number; action?: string}) => {
      if (data.uid !== this.props.groupUid) return;
      const x = Number(data.x) || 0;
      const y = Number(data.y) || 0;
      const action = data.action === 'click' ? 'click' : 'move';
      const code = `(${ghostMouseFnStr})(${x}, ${y}, ${JSON.stringify(action)})`;
      this.execInPage(code)
        .then((result: any) => {
          rpc.emit('web-pane-mouse-result', {uid: data.uid, result});
        })
        .catch((err: any) => {
          rpc.emit('web-pane-mouse-result', {uid: data.uid, result: {success: false, error: err.message}});
        });
    };
    rpc.on('web-pane-mouse', this._mouseHandler);

    rpc.on('web-pane-zoom-in', this.handleZoomIn);
    rpc.on('web-pane-zoom-out', this.handleZoomOut);
    rpc.on('web-pane-zoom-reset', this.handleZoomReset);

    // Ctrl/Cmd +/-/0 pressed while the page (native view) has focus — the manager
    // intercepts them there (they never reach this window) and forwards here.
    this._zoomKeyHandler = (_e: any, payload: {uid: string; dir: 'in' | 'out' | 'reset'}) => {
      if (payload?.uid !== this.props.groupUid) return;
      const arg = {uid: this.props.groupUid};
      if (payload.dir === 'in') this.handleZoomIn(arg);
      else if (payload.dir === 'out') this.handleZoomOut(arg);
      else this.handleZoomReset(arg);
    };
    ipcRenderer.on('web-pane:zoom-key', this._zoomKeyHandler);

    this.checkAndTriggerInitialAiChat();
  }

  componentWillUnmount() {
    rpc.removeListener('web-pane-zoom-in', this.handleZoomIn);
    rpc.removeListener('web-pane-zoom-out', this.handleZoomOut);
    rpc.removeListener('web-pane-zoom-reset', this.handleZoomReset);
    if (this._zoomKeyHandler) ipcRenderer.removeListener('web-pane:zoom-key', this._zoomKeyHandler);

    this.resizeObserver?.disconnect();
    document.removeEventListener('mousedown', this.handleOutsideClick);
    if (this._windowKeydownHandler) {
      window.removeEventListener('keydown', this._windowKeydownHandler);
    }
    window.removeEventListener('resize', this.onWindowResize);
    if (this._findHandler) {
      ipcRenderer.removeListener('web-pane:find-open', this._findHandler);
    }
    if (this._openSplitHandler) {
      ipcRenderer.removeListener('web-pane:open-split', this._openSplitHandler);
    }
    if (this._focusHandler) {
      ipcRenderer.removeListener('web-pane:focus', this._focusHandler);
    }
    if (this._frozenHandler) {
      ipcRenderer.removeListener('web-pane:frozen', this._frozenHandler);
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

    // Tear down the native view + its state listeners.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    ipcRenderer.send('web-pane:destroy', {uid: this.props.groupUid});
    if (this._stateHandler) ipcRenderer.removeListener('web-pane:state', this._stateHandler);
    if (this._foundHandler) ipcRenderer.removeListener('web-pane:found-in-page', this._foundHandler);
    if (this._domReadyHandler) ipcRenderer.removeListener('web-pane:dom-ready', this._domReadyHandler);
    if (this._onScroll) document.removeEventListener('scroll', this._onScroll, true);
    if (this._boundsRaf != null) {
      cancelAnimationFrame(this._boundsRaf);
      this._boundsRaf = null;
    }
    if (this._boundsInterval != null) {
      clearInterval(this._boundsInterval);
      this._boundsInterval = null;
    }
    if (this._headerHoverTimer != null) {
      clearTimeout(this._headerHoverTimer);
      this._headerHoverTimer = null;
    }
    // Don't leave an orphaned group-uid bell marker behind (sessions get the
    // same cleanup via SESSION_PTY_EXIT).
    this.clearPendingBell();
    if (this._io) {
      this._io.disconnect();
      this._io = null;
    }

    // Return keyboard focus to the active terminal after the web pane is removed.
    // The native view captures focus while mounted; without this the xterm
    // textarea stays unfocused (hollow cursor, input goes nowhere).
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
    // The pane rect shifts with the window → reposition the native view.
    this.reportBounds();
  };

  // ── Header hover (dwell-gated freeze-swap) ──────────────────────────────
  // The header's DOM tooltips drop over the page area, which the native view
  // would occlude — so a dwell on the header freeze-swaps the view out. The
  // dwell gate is the anti-flash: crossing the header (mousing out of the pane,
  // reaching for the tab bar) must NOT capture/hide/show the native view.
  onHeaderMouseEnter = () => {
    if (this._headerHoverTimer) clearTimeout(this._headerHoverTimer);
    this._headerHoverTimer = setTimeout(() => {
      this._headerHoverTimer = null;
      this.setState({headerHover: true});
    }, HEADER_HOVER_DWELL_MS);
  };

  onHeaderMouseLeave = () => {
    if (this._headerHoverTimer) {
      clearTimeout(this._headerHoverTimer);
      this._headerHoverTimer = null;
    }
    if (this.state.headerHover) this.setState({headerHover: false});
  };

  // ── Background-tab notify for the agent shell pane ──────────────────────
  // The Hyperia Agent page (sidecar /shell) signals a completed turn by
  // changing its <title> (relayed here via the manager's page-title-updated →
  // web-pane:state push). If that lands while this pane's TAB is inactive,
  // raise the STANDARD tab notify — the same ui.bellMarkers 🔔/flash a
  // terminal BEL sets, plus the same bell sound rung through a live Term
  // (which respects the user's bell config: silent when bell=false). Never
  // touches focus — the human's view is theirs.
  isAgentShellUrl = (u: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/shell([/?#]|$)/i.test(u);

  maybeBellOnShellUpdate = (title: string): void => {
    const url = this.state.activeUrl || this.props.url || '';
    if (!this.isAgentShellUrl(url)) return;
    const prev = this._lastShellTitle;
    this._lastShellTitle = title;
    if (prev === null || title === prev) return; // initial title / no change
    if (this.props.isTabActive !== false) return; // tab is (or may be) active — no notify
    const now = Date.now();
    if (now - this._lastShellBellAt < 3000) return; // burst guard
    this._lastShellBellAt = now;
    // Keyed by GROUP uid (not sessionUid) so we never clobber a bell the
    // underlying terminal session rang; header.ts counts leaf-group markers.
    this.props.onTabBell?.(this.props.groupUid);
    this._bellPending = true;
    // Reuse the exact terminal bell sound: any live Term's ringBell() plays
    // the shared configured Audio (they're all built from the same config).
    for (const t of activeTerminals.values()) {
      t.ringBell();
      break;
    }
  };

  clearPendingBell = (): void => {
    if (!this._bellPending) return;
    this._bellPending = false;
    this.props.onTabBellClear?.(this.props.groupUid);
  };

  // Zoom is applied to the native view in main; we track the factor here to do
  // the +/- clamp math (0.5–3.0, 0.1 step) and reflect it back.
  setZoom = (factor: number) => {
    const clamped = Math.max(0.5, Math.min(3.0, Math.round(factor * 10) / 10));
    this.setState({zoomFactor: clamped});
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    ipcRenderer.send('web-pane:zoom', {uid: this.props.groupUid, factor: clamped});
  };

  handleZoomIn = (data: {uid: string}) => {
    if (data.uid !== this.props.groupUid) return;
    this.setZoom(this.state.zoomFactor + 0.1);
  };

  handleZoomOut = (data: {uid: string}) => {
    if (data.uid !== this.props.groupUid) return;
    this.setZoom(this.state.zoomFactor - 0.1);
  };

  handleZoomReset = (data: {uid: string}) => {
    if (data.uid !== this.props.groupUid) return;
    this.setZoom(1.0);
  };

  _reloadHandler: ((uid: string) => void) | null = null;
  _clickHandler: ((data: {uid: string; text?: string; selector?: string}) => void) | null = null;
  _readHandler: ((data: {uid: string}) => void) | null = null;
  _evalHandler: ((data: {uid: string; js: string}) => void) | null = null;
  _mouseHandler: ((data: {uid: string; x: number; y: number; action?: string}) => void) | null = null;

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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    ipcRenderer.send('web-pane:stop-find', {uid: this.props.groupUid});
    this.setState({findOpen: false, findActive: 0, findTotal: 0});
  };

  doFind = (text: string, forward = true): void => {
    if (!text) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      ipcRenderer.send('web-pane:stop-find', {uid: this.props.groupUid});
      this.setState({findActive: 0, findTotal: 0});
      return;
    }
    // findNext:false starts a fresh search; web-pane:found-in-page updates counts.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    ipcRenderer.send('web-pane:find', {uid: this.props.groupUid, text, forward, findNext: false});
  };

  findStep = (forward: boolean): void => {
    const text = this.state.findText;
    if (!text) return;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    ipcRenderer.send('web-pane:find', {uid: this.props.groupUid, text, forward, findNext: true});
  };

  // Screenshot the rendered web pane. Asks main to capturePage() the native view
  // (no right-click / context-menu path — works even on pages that suppress it).
  // Copies the PNG to the clipboard and saves a copy under ~/.hyperia/snapshots/.
  // Brief icon flash as confirmation.
  captureScreenshot = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    // Grab the icon BEFORE the await — React pools synthetic events, so
    // e.currentTarget is null by the time the capture resolves.
    const iconEl = (e.currentTarget as HTMLElement).querySelector('i');
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const dataURL: string | null = await ipcRenderer.invoke('web-pane:capture', {uid: this.props.groupUid});
      if (!dataURL) return;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {clipboard, nativeImage} = require('electron');
      const img = nativeImage.createFromDataURL(dataURL);
      if (!img || img.isEmpty()) return;
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
    const fallbackTitle = (this.props as any).webName || this.state.activeUrl || this.props.url || 'Page';
    const fallbackUrl = this.state.activeUrl || this.props.url || '';
    const send = (text: string) => {
      try {
        ipcRenderer.send('new-sticky', {text});
      } catch (err) {
        console.error('new-sticky send failed:', err);
      }
    };
    if (!this.isNativeWeb()) {
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
    this.execInPage(js)
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

  // Right-click on the pane's DOM chrome (toolbar, error screen — NOT the page
  // itself; the native view's in-page menu is built in app/web-pane-manager.ts).
  handleContextMenu = (e: React.MouseEvent) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call */
    const remote = require('@electron/remote');
    const {Menu, MenuItem} = remote;
    const menu = new Menu();
    menu.append(
      new MenuItem({
        label: 'Reload',
        click: () => this.reloadWebview(false)
      })
    );
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
        label: 'Picker',
        click: () => {
          // Swap THIS web pane back to the picker (same in-group replacement
          // the terminal's Picker item uses).
          rpc.emit('new', {
            isNewGroup: false,
            activeUid: this.props.sessionUid || this.props.groupUid,
            profile: 'picker',
            groupUid: this.props.groupUid
          });
        }
      })
    );

    menu.append(new MenuItem({type: 'separator'}));

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
          // DWELLING on the header hides the native view (freeze-swap) so the
          // header's DOM tooltips — which a native WebContentsView would paint
          // over — are visible. Gated behind HEADER_HOVER_DWELL_MS so transient
          // mouse passes never flash the view; restored the moment the cursor
          // leaves.
          <div
            style={{flexShrink: 0, display: 'flex', flexDirection: 'column'}}
            onMouseEnter={this.onHeaderMouseEnter}
            onMouseLeave={this.onHeaderMouseLeave}
          >
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
          </div>
        )}

        {/* Click-off backdrop: a click anywhere outside the dropdown (including on
            the page area, whose native-view clicks never reach this document and
            whose dimmed wrapper is pointer-events:none) closes the navigator. Sits
            just under the dropdown (z 9999 < navigator's 10000) so the dropdown
            itself stays interactive. */}
        {this.state.isUrlNavigatorOpen && (
          <div
            onMouseDown={() => this.setState({isUrlNavigatorOpen: false})}
            style={{position: 'absolute', inset: 0, zIndex: 9999}}
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
              // Geometry anchor for the native WebContentsView (main-process
              // owned). This div paints nothing but its background; the native
              // view is positioned over its rect via web-pane:set-bounds. Default
              // WHITE, not transparent — a real dark page paints over it, but a
              // page that doesn't expose a sampleable body bg (HN's legacy
              // bgcolor, etc.) still gets a safe ground instead of black flash.
              <div
                ref={this.bodyRef}
                style={{
                  flex: 1,
                  display: error ? 'none' : 'flex',
                  border: 'none',
                  outline: 'none',
                  position: 'relative',
                  backgroundColor: this.state.pageBgColor || '#ffffff'
                }}
              >
                {this.state.frozenShot && (
                  // Still frame of the page shown while the native view is hidden
                  // (URL navigator / find bar open) so the overlay isn't over white.
                  <img
                    src={this.state.frozenShot}
                    alt=""
                    style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top left'}}
                  />
                )}
              </div>
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
  const termGroups = state.termGroups.termGroups;
  const termGroup = termGroups[ownProps.groupUid];
  // Walk up to this pane's ROOT group — its tab is active iff that root is the
  // active root group (used to gate the background-tab shell bell).
  let rootUid = ownProps.groupUid;
  while (termGroups[rootUid]?.parentUid) {
    rootUid = termGroups[rootUid].parentUid;
  }
  return {
    defaultProfile: state.ui.defaultProfile,
    profiles: state.ui.profiles
      ? state.ui.profiles.asMutable
        ? // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          state.ui.profiles.asMutable({deep: true})
        : state.ui.profiles
      : [],
    webName: termGroup ? termGroup.webName : undefined,
    isTabActive: rootUid === state.termGroups.activeRootGroup
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
  },
  onTabBell(uid: string) {
    dispatch(markTabBell(uid) as any);
  },
  onTabBellClear(uid: string) {
    dispatch(clearTabBell(uid) as any);
  }
});

export default connect(mapStateToProps, mapDispatchToProps)(WebPane_);
