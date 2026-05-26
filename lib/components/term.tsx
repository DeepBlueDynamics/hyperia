import {clipboard, shell, ipcRenderer} from 'electron';
import React from 'react';

import Color from 'color';
import isEqual from 'lodash/isEqual';
import pickBy from 'lodash/pickBy';
import {Terminal} from 'xterm';
import type {ITerminalOptions, IDisposable} from 'xterm';
import {CanvasAddon} from 'xterm-addon-canvas';
import {FitAddon} from 'xterm-addon-fit';
import {ImageAddon} from 'xterm-addon-image';
import {LigaturesAddon} from 'xterm-addon-ligatures';
import {SearchAddon} from 'xterm-addon-search';
import type {ISearchDecorationOptions} from 'xterm-addon-search';
import {Unicode11Addon} from 'xterm-addon-unicode11';
import {WebLinksAddon} from 'xterm-addon-web-links';
import {WebglAddon} from 'xterm-addon-webgl';

import type {TermProps} from '../../typings/hyper';
import rpc from '../rpc';
import terms from '../terms';
import processClipboard from '../utils/paste';
import {decorate} from '../utils/plugins';

import {PaneBand} from './pane-band';
import _SearchBox from './searchBox';

const path = require('path');

import 'xterm/css/xterm.css';

const SearchBox = decorate(_SearchBox, 'SearchBox');

const isWindows = ['Windows', 'Win16', 'Win32', 'WinCE'].includes(navigator.platform) || process.platform === 'win32';

// map old hterm constants to xterm.js
const CURSOR_STYLES = {
  BEAM: 'bar',
  UNDERLINE: 'underline',
  BLOCK: 'block'
} as const;

const isWebgl2Supported = (() => {
  let isSupported = window.WebGL2RenderingContext ? undefined : false;
  return () => {
    if (isSupported === undefined) {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', {
        depth: false,
        antialias: false
      });
      isSupported = gl instanceof window.WebGL2RenderingContext;
    }
    return isSupported;
  };
})();

function openUrl(uri: string): void {
  try {
    const {hostname} = new URL(uri);
    const isLocal =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
    if (isLocal) {
      rpc.emitter.emit('open web pane req', {url: uri});
    } else {
      void shell.openExternal(uri);
    }
  } catch {
    void shell.openExternal(uri);
  }
}

const getTermOptions = (props: TermProps): ITerminalOptions => {
  // Set a background color only if it is opaque
  const needTransparency = Color(props.backgroundColor).alpha() < 1;
  const backgroundColor = needTransparency ? 'rgba(0,0,0,0)' : props.backgroundColor;

  return {
    macOptionIsMeta: props.modifierKeys.altIsMeta,
    scrollback: props.scrollback,
    cursorStyle: CURSOR_STYLES[props.cursorShape],
    cursorBlink: props.cursorBlink,
    fontFamily: props.fontFamily,
    fontSize: props.fontSize,
    fontWeight: props.fontWeight,
    fontWeightBold: props.fontWeightBold,
    lineHeight: props.lineHeight,
    letterSpacing: props.letterSpacing,
    allowTransparency: needTransparency,
    macOptionClickForcesSelection: props.macOptionSelectionMode === 'force',
    windowsMode: isWindows,
    ...(isWindows && props.windowsPty && {windowsPty: props.windowsPty}),
    theme: {
      foreground: props.foregroundColor,
      background: backgroundColor,
      cursor: props.cursorColor,
      cursorAccent: props.cursorAccentColor,
      selectionBackground: props.selectionColor,
      black: props.colors.black,
      red: props.colors.red,
      green: props.colors.green,
      yellow: props.colors.yellow,
      blue: props.colors.blue,
      magenta: props.colors.magenta,
      cyan: props.colors.cyan,
      white: props.colors.white,
      brightBlack: props.colors.lightBlack,
      brightRed: props.colors.lightRed,
      brightGreen: props.colors.lightGreen,
      brightYellow: props.colors.lightYellow,
      brightBlue: props.colors.lightBlue,
      brightMagenta: props.colors.lightMagenta,
      brightCyan: props.colors.lightCyan,
      brightWhite: props.colors.lightWhite
    },
    screenReaderMode: props.screenReaderMode,
    overviewRulerWidth: 20,
    allowProposedApi: true,
    linkHandler: {
      activate: (_event: MouseEvent, uri: string) => openUrl(uri)
    }
  };
};

export default class Term extends React.PureComponent<
  TermProps,
  {
    searchOptions: {
      caseSensitive: boolean;
      wholeWord: boolean;
      regex: boolean;
    };
    searchResults:
      | {
          resultIndex: number;
          resultCount: number;
        }
      | undefined;
    isProfileMenuOpen?: boolean;
    showWebPaneInput?: boolean;
    webPaneUrlInput?: string;
    useForFutureSplits?: boolean;
    isRenamingLabel?: boolean;
    renameLabelValue?: string;
    urlInput?: string;
    urlError?: string;
    cwdHistory: string[];
    cwdCursor: number;
    isDirNavigatorOpen: boolean;
    navigatorDirs: string[];
    navigatorCurrentPath: string;
    searchBuffer: string;
    focusedIndex: number;
    navigatorLeft: number;
    navigatorWidth: number;
  }
> {
  termRef: HTMLElement | null;
  termWrapperRef: HTMLElement | null;
  termOptions: ITerminalOptions;
  disposableListeners: IDisposable[];
  defaultBellSound: HTMLAudioElement | null;
  bellSound: HTMLAudioElement | null;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  static rendererTypes: Record<string, string>;
  term!: Terminal;
  resizeObserver!: ResizeObserver;
  resizeTimeout!: NodeJS.Timeout;
  searchDecorations: ISearchDecorationOptions;
  searchBufferTimeout: NodeJS.Timeout | null = null;
  state = {
    searchOptions: {
      caseSensitive: false,
      wholeWord: false,
      regex: false
    },
    searchResults: undefined,
    isProfileMenuOpen: false,
    showWebPaneInput: false,
    webPaneUrlInput: '',
    useForFutureSplits: !this.props.defaultProfile,
    isRenamingLabel: false,
    renameLabelValue: '',
    urlInput: '',
    urlError: '',

    // CWD History Stack
    cwdHistory: [] as string[],
    cwdCursor: -1,

    // Directory Navigator
    isDirNavigatorOpen: false,
    navigatorDirs: [] as string[],
    navigatorCurrentPath: '',
    searchBuffer: '',
    focusedIndex: -1,
    navigatorLeft: 95,
    navigatorWidth: 280
  };

  menuRef = React.createRef<HTMLDivElement>();
  labelRef = React.createRef<HTMLDivElement>();
  inputRef = React.createRef<HTMLInputElement>();
  dirNavigatorRef = React.createRef<HTMLDivElement>();
  pathBarRef = React.createRef<HTMLDivElement>();

  handleOutsideClick = (e: MouseEvent) => {
    if (
      this.menuRef.current &&
      !this.menuRef.current.contains(e.target as Node) &&
      this.labelRef.current &&
      !this.labelRef.current.contains(e.target as Node)
    ) {
      this.setState({isProfileMenuOpen: false, showWebPaneInput: false});
    }

    if (
      this.state.isDirNavigatorOpen &&
      this.dirNavigatorRef.current &&
      !this.dirNavigatorRef.current.contains(e.target as Node) &&
      this.pathBarRef.current &&
      !this.pathBarRef.current.contains(e.target as Node)
    ) {
      this.setState({isDirNavigatorOpen: false});
    }
  };

  toggleProfileMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (this.state.isRenamingLabel) return;
    this.setState((state) => ({
      isProfileMenuOpen: !state.isProfileMenuOpen,
      showWebPaneInput: false,
      webPaneUrlInput: ''
    }));
  };

  handleLabelDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const splitLabel = this.props.splitLabel;
    const customTitle = (this.props as any).sessionTitle;
    const isDefaultTitle =
      !customTitle ||
      ['zsh', 'bash', 'sh', 'cmd', 'powershell', 'pwsh', 'wsl', 'node', 'tmux', 'Untitled'].some((t) =>
        customTitle.toLowerCase().includes(t)
      ) ||
      customTitle.includes('/') ||
      customTitle.includes('\\');
    const labelText = isDefaultTitle ? `Pane ${splitLabel}` : customTitle;
    this.setState({
      isRenamingLabel: true,
      renameLabelValue: labelText,
      isProfileMenuOpen: false
    });
  };

  handlePaneBandContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const isPicker = (this.props as any).sessionProfile === 'picker';

    const remote = require('@electron/remote');
    const {Menu, MenuItem} = remote;
    const menu = new Menu();

    menu.append(
      new MenuItem({
        label: 'Split Right',
        accelerator: 'Ctrl+Shift+|',
        click: () => {
          rpc.emit('split request vertical', {activeUid: this.props.uid});
        }
      })
    );

    menu.append(
      new MenuItem({
        label: 'Split Down',
        accelerator: 'Ctrl+Shift+_',
        click: () => {
          rpc.emit('split request horizontal', {activeUid: this.props.uid});
        }
      })
    );

    menu.append(
      new MenuItem({
        label: 'Clone Right',
        accelerator: 'Ctrl+Alt+Shift+|',
        click: () => {
          rpc.emit('split request vertical', {
            activeUid: this.props.uid,
            profile: (this.props as any).sessionProfile
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
            activeUid: this.props.uid,
            profile: (this.props as any).sessionProfile
          });
        }
      })
    );

    menu.append(new MenuItem({type: 'separator'}));

    menu.append(
      new MenuItem({
        label: 'Rename Pane',
        enabled: !isPicker,
        click: () => {
          this.setState({
            isRenamingLabel: true,
            renameLabelValue: (this.props as any).sessionTitle || `Pane ${this.props.splitLabel}`,
            isProfileMenuOpen: false
          });
        }
      })
    );

    menu.append(new MenuItem({type: 'separator'}));

    menu.append(
      new MenuItem({
        label: 'Close Pane',
        accelerator: 'Ctrl+Shift+W',
        click: () => {
          if (this.props.onClosePane && this.props.groupUid) {
            this.props.onClosePane(this.props.groupUid);
          }
        }
      })
    );

    menu.popup();
  };

  submitUrl = () => {
    const trimmed = (this.state.urlInput || '').trim();
    if (!trimmed) return;

    const isValidUrl = (str: string): boolean => {
      const t = str.trim();
      try {
        const url = new URL(t);
        if (url.protocol && url.host) return true;
      } catch {}
      if (/^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(t)) {
        return true;
      }
      if (/^(https?:\/\/)?([a-zA-Z0-9-]+\.)+(local|test)(:\d+)?(\/.*)?$/i.test(t)) {
        return true;
      }
      if (/^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/i.test(t)) {
        return true;
      }
      return false;
    };

    if (isValidUrl(trimmed)) {
      let finalUrl = trimmed;
      if (!/^https?:\/\//i.test(finalUrl)) {
        if (/^(localhost|127\.0\.0\.1)/i.test(finalUrl)) {
          finalUrl = 'http://' + finalUrl;
        } else {
          finalUrl = 'https://' + finalUrl;
        }
      }
      const {groupUid, uid, switchPaneToWeb} = this.props as any;
      if (switchPaneToWeb && groupUid) {
        switchPaneToWeb(groupUid, uid, finalUrl);
      }
      this.setState({urlInput: '', urlError: ''});
    } else {
      this.setState({urlError: "Doesn't look like a URL"});
    }
  };

  handleShellProfileSelect = (p: any) => {
    const {groupUid, uid, switchPaneProfile} = this.props as any;
    if (switchPaneProfile && groupUid) {
      switchPaneProfile(groupUid, uid, p.name);
    }
    this.setState({isProfileMenuOpen: false, showWebPaneInput: false});
  };

  handleRightClickProfile = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    try {
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
    const trimmed = this.state.webPaneUrlInput.trim();
    if (!trimmed) return;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
    const {groupUid, uid, switchPaneToWeb} = this.props as any;
    if (switchPaneToWeb && groupUid) {
      switchPaneToWeb(groupUid, uid, url);
    }
    this.setState({isProfileMenuOpen: false, showWebPaneInput: false, webPaneUrlInput: ''});
  };

  handleWebPaneCancel = () => {
    this.setState({showWebPaneInput: false, webPaneUrlInput: ''});
  };

  constructor(props: TermProps) {
    super(props);
    props.ref_(props.uid, this);
    this.termRef = null;
    this.termWrapperRef = null;
    this.termOptions = {};
    this.disposableListeners = [];
    this.defaultBellSound = null;
    this.bellSound = null;
    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.searchDecorations = {
      activeMatchColorOverviewRuler: Color(this.props.cursorColor).hex(),
      matchOverviewRuler: Color(this.props.borderColor).hex(),
      activeMatchBackground: Color(this.props.cursorColor).hex(),
      activeMatchBorder: Color(this.props.cursorColor).hex(),
      matchBorder: Color(this.props.cursorColor).hex()
    };
  }

  // The main process shows this in the About dialog
  static reportRenderer(uid: string, type: string) {
    const rendererTypes = Term.rendererTypes || {};
    if (rendererTypes[uid] !== type) {
      rendererTypes[uid] = type;
      Term.rendererTypes = rendererTypes;
      window.rpc.emit('info renderer', {uid, type});
    }
  }

  componentDidMount() {
    const {props} = this;

    this.termOptions = getTermOptions(props);
    this.term = props.term || new Terminal(this.termOptions);
    this.defaultBellSound = new Audio(
      // Source: https://freesound.org/people/altemark/sounds/45759/
      // This sound is released under the Creative Commons Attribution 3.0 Unported
      // (CC BY 3.0) license. It was created by 'altemark'. No modifications have been
      // made, apart from the conversion to base64.
      'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjMyLjEwNAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
    );
    this.setBellSound(props.bell, props.bellSound);

    // The parent element for the terminal is attached and removed manually so
    // that we can preserve it across mounts and unmounts of the component
    this.termRef = props.term ? props.term.element!.parentElement! : document.createElement('div');
    this.termRef.className = 'term_fit term_term';

    this.termWrapperRef?.appendChild(this.termRef);

    const initialCwd = (props as any).sessionCwd;
    if (initialCwd) {
      this.setState({
        cwdHistory: [initialCwd],
        cwdCursor: 0
      });
    }

    if (!props.term) {
      const needTransparency = Color(props.backgroundColor).alpha() < 1;
      let useWebGL = false;
      if (props.webGLRenderer) {
        if (needTransparency) {
          console.warn(
            'WebGL Renderer has been disabled since it does not support transparent backgrounds yet. ' +
              'Falling back to canvas-based rendering.'
          );
        } else if (!isWebgl2Supported()) {
          console.warn('WebGL2 is not supported on your machine. Falling back to canvas-based rendering.');
        } else {
          // Experimental WebGL renderer needs some more glue-code to make it work on Hyper.
          // If you're working on enabling back WebGL, you will also need to look into `xterm-addon-ligatures` support for that renderer.
          useWebGL = true;
        }
      }
      Term.reportRenderer(props.uid, useWebGL ? 'WebGL' : 'Canvas');

      const shallActivateWebLink = (event: MouseEvent): boolean => {
        if (!event) return false;
        return props.webLinksActivationKey ? event[`${props.webLinksActivationKey}Key`] : true;
      };

      this.term.attachCustomKeyEventHandler(this.keyboardHandler);
      this.term.loadAddon(this.fitAddon);
      this.term.loadAddon(this.searchAddon);
      this.term.loadAddon(
        new WebLinksAddon((event, uri) => {
          if (shallActivateWebLink(event)) openUrl(uri);
        })
      );
      // Custom link provider for URLs that wrap across multiple rows
      this.term.registerLinkProvider({
        provideLinks: (rowIndex: number, callback: (links: any[] | undefined) => void) => {
          const buffer = this.term.buffer.active;
          // Look up to 6 rows around the hovered row to catch long wrapped URLs
          const startRow = Math.max(0, rowIndex - 3);
          const endRow = Math.min(buffer.length - 1, rowIndex + 3);

          // Build segments. Each segment contains the trimmed text of one row,
          // with metadata about the original column where each character lives.
          // We strip trailing whitespace before concatenation so that padding
          // doesn't get spliced into URLs.
          type Segment = {
            row: number;
            trimmedText: string;
            charCols: number[];
          };
          let segments: Segment[] = [];

          for (let r = startRow; r <= endRow; r++) {
            const line = buffer.getLine(r);
            if (!line) continue;

            // If this line is not a wrap continuation and we already started
            // collecting, reset — wrapped runs are bounded.
            if (r > startRow && !line.isWrapped && segments.length > 0) {
              // If our hovered row is already in this run, stop here.
              if (segments.some((s) => s.row === rowIndex)) break;
              segments = [];
            }

            // Pull each cell text + its column index, dropping trailing whitespace.
            const charCols: number[] = [];
            const chars: string[] = [];
            for (let c = 0; c < line.length; c++) {
              const cell = line.getCell(c);
              if (!cell) continue;
              const ch = cell.getChars();
              if (ch.length > 0) {
                chars.push(ch);
                charCols.push(c);
              }
            }
            // Trim trailing whitespace
            while (chars.length > 0 && /^\s+$/.test(chars[chars.length - 1])) {
              chars.pop();
              charCols.pop();
            }
            const trimmedText = chars.join('');
            segments.push({row: r, trimmedText, charCols});
          }

          // Concatenate trimmed segments — wrapped continuations join cleanly.
          let combined = '';
          const segOffsets: {
            row: number;
            offset: number;
            charCols: number[];
          }[] = [];
          for (const seg of segments) {
            segOffsets.push({
              row: seg.row,
              offset: combined.length,
              charCols: seg.charCols
            });
            combined += seg.trimmedText;
          }

          // Match URLs
          const urlRegex = /https?:\/\/[^\s<>'")\]}>]+/g;
          let match;
          const links: any[] = [];
          while ((match = urlRegex.exec(combined)) !== null) {
            const url = match[0];
            const matchStart = match.index;
            const matchEnd = matchStart + url.length;

            // Map combined-text indices back to (row, col)
            const findCoord = (idx: number) => {
              for (let i = segOffsets.length - 1; i >= 0; i--) {
                const so = segOffsets[i];
                if (idx >= so.offset) {
                  const localIdx = idx - so.offset;
                  if (localIdx < so.charCols.length) {
                    return {row: so.row, col: so.charCols[localIdx]};
                  } else if (localIdx === so.charCols.length && so.charCols.length > 0) {
                    // End-of-segment — point past the last char
                    return {
                      row: so.row,
                      col: so.charCols[so.charCols.length - 1] + 1
                    };
                  }
                }
              }
              return null;
            };

            const startCoord = findCoord(matchStart);
            const endCoord = findCoord(matchEnd - 1);
            if (!startCoord || !endCoord) continue;

            // Only show this link on rows that the hovered row touches
            if (startCoord.row > rowIndex || endCoord.row < rowIndex) continue;

            links.push({
              range: {
                start: {x: startCoord.col + 1, y: startCoord.row + 1},
                end: {x: endCoord.col + 1, y: endCoord.row + 1}
              },
              text: url,
              activate: (_event: MouseEvent, text: string) => {
                if (shallActivateWebLink(_event)) openUrl(text);
              }
            });
          }
          callback(links.length > 0 ? links : undefined);
        }
      });
      this.term.open(this.termRef);

      if (useWebGL) {
        const webglAddon = new WebglAddon();
        this.term.loadAddon(webglAddon);
        webglAddon.onContextLoss(() => {
          console.warn('WebGL context lost. Falling back to canvas-based rendering.');
          webglAddon.dispose();
          this.term.loadAddon(new CanvasAddon());
        });
      } else {
        this.term.loadAddon(new CanvasAddon());
      }

      if (props.disableLigatures !== true && !useWebGL) {
        this.term.loadAddon(new LigaturesAddon());
      }

      this.term.loadAddon(new Unicode11Addon());
      this.term.unicode.activeVersion = '11';

      if (props.imageSupport) {
        this.term.loadAddon(new ImageAddon());
      }
    } else {
      // get the cached plugins
      this.fitAddon = props.fitAddon!;
      this.searchAddon = props.searchAddon!;
    }

    try {
      this.term.element!.style.padding = props.padding;
    } catch (error) {
      console.log(error);
    }

    this.fitAddon.fit();

    if (this.props.isTermActive) {
      this.term.focus();
    }

    if (props.onTitle) {
      this.disposableListeners.push(this.term.onTitleChange((title) => props.onTitle(title)));
    }

    if (props.onActive) {
      this.term.textarea?.addEventListener('focus', props.onActive);
      this.disposableListeners.push({
        dispose: () => this.term.textarea?.removeEventListener('focus', this.props.onActive)
      });
    }

    if (props.onData) {
      this.disposableListeners.push(this.term.onData(props.onData));
    }

    this.term.onBell(() => {
      this.ringBell();
      this.props.onBell?.();
    });

    if (props.onResize) {
      this.disposableListeners.push(
        this.term.onResize(({cols, rows}) => {
          props.onResize(cols, rows);
        })
      );

      // the row and col of init session is null, so reize the node-pty
      props.onResize(this.term.cols, this.term.rows);
    }

    if (props.onCursorMove) {
      this.disposableListeners.push(
        this.term.onCursorMove(() => {
          const cursorFrame = {
            x: this.term.buffer.active.cursorX * (this.term as any)._core._renderService.dimensions.actualCellWidth,
            y: this.term.buffer.active.cursorY * (this.term as any)._core._renderService.dimensions.actualCellHeight,
            width: (this.term as any)._core._renderService.dimensions.actualCellWidth,
            height: (this.term as any)._core._renderService.dimensions.actualCellHeight,
            col: this.term.buffer.active.cursorX,
            row: this.term.buffer.active.cursorY
          };
          props.onCursorMove?.(cursorFrame);
        })
      );
    }

    this.disposableListeners.push(
      this.searchAddon.onDidChangeResults((results) => {
        this.setState((state) => ({
          ...state,
          searchResults: results
        }));
      })
    );

    window.addEventListener('paste', this.onWindowPaste, {
      capture: true
    });

    terms[this.props.uid] = this;
  }

  getTermDocument() {
    console.warn(
      'The underlying terminal engine of Hyper no longer ' +
        'uses iframes with individual `document` objects for each ' +
        'terminal instance. This method call is retained for ' +
        "backwards compatibility reasons. It's ok to attach directly" +
        'to the `document` object of the main `window`.'
    );
    return document;
  }

  // intercepting paste event for any necessary processing of
  // clipboard data, if result is falsy, paste event continues
  onWindowPaste = (e: Event) => {
    if (!this.props.isTermActive) return;

    const processed = processClipboard();
    if (processed) {
      e.preventDefault();
      e.stopPropagation();
      this.term.paste(processed);
    }
  };

  onMouseUp = (e: React.MouseEvent) => {
    if (this.props.quickEdit && e.button === 2) {
      if (this.term.hasSelection()) {
        clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
      } else {
        document.execCommand('paste');
      }
    } else if (this.props.copyOnSelect && this.term.hasSelection()) {
      clipboard.writeText(this.term.getSelection());
    }
  };

  write(data: string | Uint8Array) {
    this.term.write(data);
  }

  focus = () => {
    this.term.focus();
  };

  clear() {
    this.term.clear();
  }

  reset() {
    this.term.reset();
  }

  searchNext = (searchTerm: string) => {
    this.searchAddon.findNext(searchTerm, {
      ...this.state.searchOptions,
      decorations: this.searchDecorations
    });
  };

  searchPrevious = (searchTerm: string) => {
    this.searchAddon.findPrevious(searchTerm, {
      ...this.state.searchOptions,
      decorations: this.searchDecorations
    });
  };

  closeSearchBox = () => {
    this.props.onCloseSearch();
    this.searchAddon.clearDecorations();
    this.searchAddon.clearActiveDecoration();
    this.setState((state) => ({
      ...state,
      searchResults: undefined
    }));
    this.term.focus();
  };

  resize(cols: number, rows: number) {
    this.term.resize(cols, rows);
  }

  selectAll() {
    this.term.selectAll();
  }

  fitResize() {
    if (!this.termWrapperRef) {
      return;
    }
    this.fitAddon.fit();
  }

  keyboardHandler = (e: any) => {
    // Intercept Alt+Left/Alt+Right for directory history navigation
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      this.navigateBack();
      return false;
    }
    if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      this.navigateForward();
      return false;
    }
    // Intercept Ctrl+Shift+O to toggle directory navigator
    if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'O') {
      e.preventDefault();
      this.toggleDirNavigator();
      return false;
    }
    return !e.catched;
  };

  navigateBack = () => {
    const {cwdHistory, cwdCursor} = this.state;
    if (cwdCursor > 0) {
      const targetPath = cwdHistory[cwdCursor - 1];
      if (this.props.onData) {
        this.props.onData(`cd "${targetPath}"\r`);
      }
      this.setState({cwdCursor: cwdCursor - 1});
    }
  };

  navigateForward = () => {
    const {cwdHistory, cwdCursor} = this.state;
    if (cwdCursor > -1 && cwdCursor < cwdHistory.length - 1) {
      const targetPath = cwdHistory[cwdCursor + 1];
      if (this.props.onData) {
        this.props.onData(`cd "${targetPath}"\r`);
      }
      this.setState({cwdCursor: cwdCursor + 1});
    }
  };

  handleBackContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const {cwdHistory, cwdCursor} = this.state;
    if (cwdCursor <= 0) return;

    const remote = require('@electron/remote');
    const {Menu, MenuItem} = remote;
    const menu = new Menu();

    for (let i = cwdCursor - 1; i >= 0; i--) {
      const pathVal = cwdHistory[i];
      menu.append(
        new MenuItem({
          label: pathVal,
          click: () => {
            if (this.props.onData) {
              this.props.onData(`cd "${pathVal}"\r`);
            }
            this.setState({cwdCursor: i});
          }
        })
      );
    }
    menu.popup();
  };

  handleForwardContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const {cwdHistory, cwdCursor} = this.state;
    if (cwdCursor === -1 || cwdCursor >= cwdHistory.length - 1) return;

    const remote = require('@electron/remote');
    const {Menu, MenuItem} = remote;
    const menu = new Menu();

    for (let i = cwdCursor + 1; i < cwdHistory.length; i++) {
      const pathVal = cwdHistory[i];
      menu.append(
        new MenuItem({
          label: pathVal,
          click: () => {
            if (this.props.onData) {
              this.props.onData(`cd "${pathVal}"\r`);
            }
            this.setState({cwdCursor: i});
          }
        })
      );
    }
    menu.popup();
  };

  toggleDirNavigator = () => {
    const {isDirNavigatorOpen, navigatorCurrentPath} = this.state;
    const sessionCwd = (this.props as any).sessionCwd;
    // Empty string → the sidecar resolves to the user's home directory.
    const activePath = navigatorCurrentPath || sessionCwd || '';

    if (!isDirNavigatorOpen) {
      let navigatorLeft = 95;
      let navigatorWidth = 280;

      if (this.pathBarRef.current && this.labelRef.current) {
        const pathBarRect = this.pathBarRef.current.getBoundingClientRect();
        const labelRect = this.labelRef.current.getBoundingClientRect();
        navigatorLeft = pathBarRect.left - labelRect.left;
        navigatorWidth = Math.max(250, pathBarRect.width);
      }

      this.setState(
        {
          isDirNavigatorOpen: true,
          navigatorLeft,
          navigatorWidth
        },
        () => {
          requestAnimationFrame(() => {
            this.dirNavigatorRef.current?.focus();
          });
        }
      );
      // navigatorCurrentPath / navigatorDirs / searchBuffer / focusedIndex are
      // set by loadNavigatorDirs once the sidecar responds.
      this.loadNavigatorDirs(activePath);
    } else {
      this.setState({
        isDirNavigatorOpen: false
      });
    }
  };

  // Directory listing lives in the Rust sidecar (fsnav): GET /api/fs/dirs
  // resolves the path (home if absent/invalid) and returns only real, visible
  // directories — dotfiles and Windows system dirs like $Recycle.Bin are
  // filtered there, not re-implemented in the renderer. Sets navigatorCurrentPath
  // to the sidecar's resolved path so an empty/bad path lands on home.
  // BROWSE only — never cd. Clicking/navigating just moves the popup's view
  // and fetches that directory's contents. We must NOT send `cd` while the
  // user is browsing: if a CLI program is running in the pane, the keystrokes
  // would feed the program, not the shell. The actual cd is deferred to the
  // explicit Go action (goToNavigatorDir).
  loadNavigatorDirs = (targetPath: string) => {
    const port = process.env.HYPERIA_PORT || '9800';
    // Reflect the requested path immediately; the fetch corrects it to the
    // sidecar's resolved path (e.g. home) when it returns.
    this.setState({navigatorCurrentPath: targetPath, searchBuffer: '', focusedIndex: -1});
    fetch(`http://localhost:${port}/api/fs/dirs?path=${encodeURIComponent(targetPath)}`)
      .then((r) => r.json())
      .then((data: {path: string; parent: string | null; dirs: string[]}) => {
        this.setState({navigatorCurrentPath: data.path, navigatorDirs: data.dirs});
      })
      .catch((err) => {
        console.error('Failed to load directory listing:', err);
        this.setState({navigatorDirs: []});
      });
  };

  // The ONLY place that actually changes the shell's directory — on an explicit
  // Go, never on browse. Queued navigation lands here.
  goToNavigatorDir = () => {
    const target = this.state.navigatorCurrentPath;
    if (target && this.props.onData) {
      this.props.onData(`cd "${target}"\r`);
    }
    this.setState({isDirNavigatorOpen: false});
  };

  renderNavigatorBreadcrumbs = () => {
    const currentPath = this.state.navigatorCurrentPath || '/';
    const sep = path.sep || '/';
    const segments = currentPath.split(sep).filter(Boolean);
    const hops: {name: string; path: string}[] = [];
    let accum = '';

    segments.forEach((seg, idx) => {
      if (isWindows && idx === 0 && seg.endsWith(':')) {
        accum = seg + sep;
      } else {
        accum = accum ? path.join(accum, seg) : isWindows ? seg : sep + seg;
      }
      hops.push({
        name: seg,
        path: accum
      });
    });

    const handleHopClick = (hopPath: string) => {
      this.loadNavigatorDirs(hopPath);
    };

    const rootPath = isWindows ? 'C:\\' : '/';

    return (
      <div
        className="term_navigatorBreadcrumbs"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '4px',
          padding: '8px 12px',
          borderBottom: '0.5px solid var(--border-neutral)'
        }}
      >
        <span
          onClick={() => handleHopClick(rootPath)}
          style={{cursor: 'pointer', display: 'inline-flex', alignItems: 'center', color: 'var(--text-secondary)'}}
          title="Root directory"
        >
          <i className="ti ti-home" style={{fontSize: '13px'}} aria-hidden="true" />
        </span>
        {hops.map((hop, index) => {
          const isLast = index === hops.length - 1;
          return (
            <React.Fragment key={hop.path}>
              <span style={{fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)'}}>/</span>
              {isLast ? (
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-primary)',
                    fontWeight: 500,
                    fontFamily: 'var(--font-mono)'
                  }}
                >
                  {hop.name}
                </span>
              ) : (
                <span
                  onClick={() => handleHopClick(hop.path)}
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                    cursor: 'pointer'
                  }}
                  className="term_breadcrumbHop"
                >
                  {hop.name}
                </span>
              )}
            </React.Fragment>
          );
        })}
        {/* Go — the ONLY thing that cd's the shell. Browsing above just moves
            the popup's view; nothing is sent to the PTY until Go, so a running
            CLI never gets a stray cd. */}
        <span
          onClick={this.goToNavigatorDir}
          className="term_navigatorGo"
          title="cd to this directory"
          style={{
            marginLeft: 'auto',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '11px',
            fontWeight: 600,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-info)',
            border: '0.5px solid var(--border-neutral)',
            borderRadius: '3px',
            padding: '1px 8px'
          }}
        >
          Go
          <i className="ti ti-arrow-right" style={{fontSize: '12px'}} aria-hidden="true" />
        </span>
      </div>
    );
  };

  renderNavigatorDirectoryList = () => {
    const {navigatorDirs, navigatorCurrentPath, searchBuffer, focusedIndex} = this.state;

    const handleRowClick = (dirName: string) => {
      const targetPath = path.join(navigatorCurrentPath, dirName);
      this.loadNavigatorDirs(targetPath);
    };

    if (navigatorDirs.length === 0) {
      return (
        <div
          style={{
            padding: '24px 12px',
            textAlign: 'center',
            fontSize: '11px',
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-sans)'
          }}
        >
          No subdirectories
        </div>
      );
    }

    return (
      <div style={{maxHeight: '220px', overflowY: 'auto'}} className="term_navigatorDirList">
        {navigatorDirs.map((dirName, index) => {
          const isMatched = index === focusedIndex;
          const isBufferActive = searchBuffer.length > 0;
          const showFocus = isMatched;

          let dirLabelNode: React.ReactNode = dirName;
          if (showFocus && isBufferActive) {
            const prefixLower = searchBuffer.toLowerCase();
            const dirLower = dirName.toLowerCase();
            if (dirLower.startsWith(prefixLower)) {
              const matchedPart = dirName.substring(0, prefixLower.length);
              const restPart = dirName.substring(prefixLower.length);
              dirLabelNode = (
                <span style={{color: 'var(--info-text)', fontWeight: 500}}>
                  <span style={{textDecoration: 'underline', textUnderlineOffset: '2px'}}>{matchedPart}</span>
                  <span>{restPart}</span>
                </span>
              );
            }
          }

          return (
            <div
              key={dirName}
              onClick={() => handleRowClick(dirName)}
              className={`term_navigatorDirRow ${showFocus ? 'term_navigatorDirRow_focused' : ''}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 12px',
                cursor: 'pointer',
                background: showFocus ? 'var(--info-bg)' : undefined,
                transition: 'background 0.1s ease'
              }}
            >
              <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                <i
                  className="ti ti-folder term_folderIcon"
                  style={{fontSize: '13px', color: showFocus ? 'var(--info-text)' : 'var(--text-tertiary)'}}
                  aria-hidden="true"
                />
                <span
                  className="term_dirLabel"
                  style={{
                    fontSize: '11px',
                    color: showFocus ? 'var(--info-text)' : 'var(--text-primary)',
                    fontFamily: 'var(--font-sans)',
                    fontWeight: showFocus ? 500 : 'normal',
                    userSelect: 'none'
                  }}
                >
                  {dirLabelNode}
                </span>
              </div>
              <i
                className="ti ti-chevron-right term_chevronIcon"
                style={{fontSize: '11px', color: showFocus ? 'var(--info-text)' : 'var(--text-tertiary)'}}
                aria-hidden="true"
              />
            </div>
          );
        })}
      </div>
    );
  };

  renderNavigatorFooter = () => {
    const {navigatorDirs, searchBuffer, focusedIndex} = this.state;
    const isBufferActive = searchBuffer.length > 0;

    if (isBufferActive) {
      const hasMatch = focusedIndex !== -1;
      const pillBg = hasMatch ? 'var(--info-bg)' : 'var(--danger-bg)';
      const pillColor = hasMatch ? 'var(--info-text)' : 'var(--danger-text)';
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
          <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
            <span style={{fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)'}}>
              Typing
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                padding: '1px 5px',
                background: pillBg,
                color: pillColor,
                borderRadius: '3px',
                fontWeight: 500
              }}
            >
              {searchBuffer}
            </span>
          </div>
          <span style={{fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)'}}>
            Esc to clear
          </span>
        </div>
      );
    }

    const count = navigatorDirs.length;
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
          {count} {count === 1 ? 'directory' : 'directories'}
        </span>
        <span style={{fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)'}}>
          Esc to close
        </span>
      </div>
    );
  };

  handleNavigatorKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const {navigatorDirs, searchBuffer, focusedIndex, navigatorCurrentPath} = this.state;
    const key = e.key;

    if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (searchBuffer.length > 0) {
        this.setState({searchBuffer: '', focusedIndex: -1});
      } else {
        this.setState({isDirNavigatorOpen: false});
        this.focus();
      }
      return;
    }

    if (key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      if (searchBuffer.length > 0) {
        const newBuffer = searchBuffer.slice(0, -1);
        let newFocusedIndex = -1;
        if (newBuffer.length > 0) {
          const prefix = newBuffer.toLowerCase();
          newFocusedIndex = navigatorDirs.findIndex((dir) => dir.toLowerCase().startsWith(prefix));
        }
        this.setState({
          searchBuffer: newBuffer,
          focusedIndex: newFocusedIndex
        });
      } else {
        const parentPath = path.dirname(navigatorCurrentPath);
        if (parentPath && parentPath !== navigatorCurrentPath) {
          this.loadNavigatorDirs(parentPath);
        }
      }
      return;
    }

    if (key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (navigatorDirs.length > 0) {
        let newIdx = 0;
        if (focusedIndex !== -1) {
          newIdx = (focusedIndex + 1) % navigatorDirs.length;
        }
        this.setState({
          focusedIndex: newIdx,
          searchBuffer: ''
        });
      }
      return;
    }

    if (key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (navigatorDirs.length > 0) {
        let newIdx = navigatorDirs.length - 1;
        if (focusedIndex !== -1) {
          newIdx = focusedIndex === 0 ? navigatorDirs.length - 1 : focusedIndex - 1;
        }
        this.setState({
          focusedIndex: newIdx,
          searchBuffer: ''
        });
      }
      return;
    }

    if (key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (focusedIndex >= 0 && focusedIndex < navigatorDirs.length) {
        const dirName = navigatorDirs[focusedIndex];
        const targetPath = path.join(navigatorCurrentPath, dirName);
        this.loadNavigatorDirs(targetPath);
      }
      return;
    }

    if (key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const isPrintable = key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (isPrintable) {
      e.preventDefault();
      e.stopPropagation();

      const keyLower = key.toLowerCase();
      const isSameCharCycle = searchBuffer.toLowerCase() === keyLower;
      let newBuffer = isSameCharCycle ? searchBuffer : searchBuffer + key;
      if (isSameCharCycle) {
        newBuffer = keyLower;
      }

      let newFocusedIndex = -1;
      if (isSameCharCycle) {
        const matchingIndices: number[] = [];
        navigatorDirs.forEach((dir, idx) => {
          if (dir.toLowerCase().startsWith(keyLower)) {
            matchingIndices.push(idx);
          }
        });

        if (matchingIndices.length > 0) {
          const currentMatchIdx = matchingIndices.indexOf(focusedIndex);
          if (currentMatchIdx !== -1) {
            newFocusedIndex = matchingIndices[(currentMatchIdx + 1) % matchingIndices.length];
          } else {
            newFocusedIndex = matchingIndices[0];
          }
        }
      } else {
        const prefix = newBuffer.toLowerCase();
        newFocusedIndex = navigatorDirs.findIndex((dir) => dir.toLowerCase().startsWith(prefix));
      }

      this.setState({
        searchBuffer: newBuffer,
        focusedIndex: newFocusedIndex
      });

      if (this.searchBufferTimeout) {
        clearTimeout(this.searchBufferTimeout);
      }
      this.searchBufferTimeout = setTimeout(() => {
        this.setState({searchBuffer: ''});
      }, 700);
    }
  };

  setBellSound(bell: 'SOUND' | false, sound: string | null) {
    if (bell && bell.toUpperCase() === 'SOUND') {
      this.bellSound = sound ? new Audio(sound) : this.defaultBellSound;
    } else {
      this.bellSound = null;
    }
  }

  ringBell() {
    void this.bellSound?.play();
  }

  componentDidUpdate(prevProps: TermProps, prevState: any) {
    const sessionCwd = (this.props as any).sessionCwd;
    const prevSessionCwd = (prevProps as any).sessionCwd;
    if (sessionCwd && sessionCwd !== prevSessionCwd) {
      const {cwdHistory, cwdCursor} = this.state;
      if (cwdCursor === -1 || cwdHistory[cwdCursor] !== sessionCwd) {
        const truncated = cwdHistory.slice(0, cwdCursor + 1);
        truncated.push(sessionCwd);
        let finalHistory = truncated;
        let finalCursor = truncated.length - 1;
        if (finalHistory.length > 64) {
          finalHistory = finalHistory.slice(finalHistory.length - 64);
          finalCursor = finalHistory.length - 1;
        }
        this.setState({
          cwdHistory: finalHistory,
          cwdCursor: finalCursor
        });
      }
    }

    const wasActive = prevState.isProfileMenuOpen || prevState.isDirNavigatorOpen;
    const isActive = this.state.isProfileMenuOpen || this.state.isDirNavigatorOpen;

    if (isActive && !wasActive) {
      document.addEventListener('mousedown', this.handleOutsideClick);
    } else if (!isActive && wasActive) {
      document.removeEventListener('mousedown', this.handleOutsideClick);
    }

    if (this.props.isTermActive && !prevProps.isTermActive) {
      this.focus();
    }

    if (!prevProps.cleared && this.props.cleared) {
      this.clear();
    }

    const nextTermOptions = getTermOptions(this.props);

    if (prevProps.bell !== this.props.bell || prevProps.bellSound !== this.props.bellSound) {
      this.setBellSound(this.props.bell, this.props.bellSound);
    }

    if (prevProps.search && !this.props.search) {
      this.closeSearchBox();
    }

    // Update only options that have changed.
    this.term.options = pickBy(
      nextTermOptions,
      (value, key) => !isEqual(this.termOptions[key as keyof ITerminalOptions], value)
    );

    this.termOptions = nextTermOptions;

    try {
      this.term.element!.style.padding = this.props.padding;
    } catch (error) {
      console.log(error);
    }

    if (
      this.props.fontSize !== prevProps.fontSize ||
      this.props.fontFamily !== prevProps.fontFamily ||
      this.props.lineHeight !== prevProps.lineHeight ||
      this.props.letterSpacing !== prevProps.letterSpacing
    ) {
      // resize to fit the container
      this.fitResize();
    }

    if (prevProps.rows !== this.props.rows || prevProps.cols !== this.props.cols) {
      this.resize(this.props.cols!, this.props.rows!);
    }
  }

  onTermWrapperRef = (component: HTMLElement | null) => {
    this.termWrapperRef = component;

    if (component) {
      this.resizeObserver = new ResizeObserver(() => {
        clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => {
          this.fitResize();
        }, 500);
      });
      this.resizeObserver.observe(component);
    } else {
      this.resizeObserver?.disconnect();
    }
  };

  componentWillUnmount() {
    document.removeEventListener('mousedown', this.handleOutsideClick);
    terms[this.props.uid] = null;
    this.termWrapperRef?.removeChild(this.termRef!);
    this.props.ref_(this.props.uid, null);

    // to clean up the terminal, we remove the listeners
    // instead of invoking `destroy`, since it will make the
    // term insta un-attachable in the future (which we need
    // to do in case of splitting, see `componentDidMount`
    this.disposableListeners.forEach((handler) => handler.dispose());
    this.disposableListeners = [];

    window.removeEventListener('paste', this.onWindowPaste, {
      capture: true
    });
  }

  render() {
    const splitLabel = this.props.splitLabel;
    const sessionProfile = (this.props as any).sessionProfile;
    const customTitle = (this.props as any).sessionTitle;
    const isDefaultTitle =
      !customTitle ||
      ['zsh', 'bash', 'sh', 'cmd', 'powershell', 'pwsh', 'wsl', 'node', 'tmux', 'Untitled'].some((t) =>
        customTitle.toLowerCase().includes(t)
      ) ||
      customTitle.includes('/') ||
      customTitle.includes('\\');
    const labelText = isDefaultTitle ? `Pane ${splitLabel}` : customTitle;

    const nameLower = (sessionProfile || '').toLowerCase();
    let icon = '⚡';
    if (nameLower.includes('powershell') || nameLower.includes('pwsh')) icon = '🐚';
    else if (nameLower.includes('wsl') || nameLower.includes('ubuntu') || nameLower.includes('debian')) icon = '🐧';
    else if (nameLower.includes('bash') || nameLower.includes('git')) icon = '⌥';
    else if (nameLower.includes('cmd') || nameLower.includes('command')) icon = '💻';
    else if (nameLower.includes('claude')) icon = '🤖';

    const isPicker = sessionProfile === 'picker';
    const tint = isPicker
      ? 'picker'
      : splitLabel === 'a'
        ? 'success'
        : splitLabel === 'b'
          ? 'info'
          : splitLabel === 'c'
            ? 'warning'
            : 'danger';
    const showLabelStrip = !!splitLabel || isPicker;

    return (
      <div
        className={`term_fit ${this.props.isTermActive ? 'term_active' : ''}`}
        onMouseUp={this.onMouseUp}
        style={{position: 'relative'}}
      >
        {this.props.customChildrenBefore}
        {showLabelStrip && (
          <PaneBand
            ref={this.labelRef}
            paneType="shell"
            tint={isPicker ? 'neutral' : (tint as any)}
            isPlaceholder={isPicker}
            label={
              this.state.isRenamingLabel ? (
                <input
                  type="text"
                  className="term_paneRenameInput"
                  value={this.state.renameLabelValue}
                  onChange={(e) => this.setState({renameLabelValue: e.target.value})}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation();
                      const val = this.state.renameLabelValue.trim();
                      if (val && this.props.onTitle) {
                        this.props.onTitle(val, true);
                      }
                      this.setState({isRenamingLabel: false});
                    } else if (e.key === 'Escape') {
                      e.stopPropagation();
                      this.setState({isRenamingLabel: false});
                    }
                  }}
                  onBlur={() => {
                    const val = this.state.renameLabelValue.trim();
                    if (val && this.props.onTitle) {
                      this.props.onTitle(val, true);
                    }
                    this.setState({isRenamingLabel: false});
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span onDoubleClick={this.handleLabelDoubleClick}>{labelText}</span>
              )
            }
            icon={<span>{icon}</span>}
            profileChip={
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  fontWeight: 400,
                  opacity: 0.85,
                  fontSize: '10px',
                  marginLeft: 'var(--space-4)',
                  cursor: 'pointer'
                }}
              >
                {sessionProfile} <span style={{fontSize: '7px'}}>▼</span>
              </span>
            }
            navCluster={
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-4)',
                  marginLeft: 'var(--space-6)',
                  marginRight: 'var(--space-6)',
                  flexShrink: 0
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <span
                  className="term_controlIcon term_tooltipTrigger"
                  onClick={this.navigateBack}
                  onContextMenu={this.handleBackContextMenu}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    cursor: this.state.cwdCursor <= 0 ? 'default' : 'pointer',
                    opacity: this.state.cwdCursor <= 0 ? 0.4 : 1,
                    pointerEvents: this.state.cwdCursor <= 0 ? 'none' : 'auto'
                  }}
                >
                  <i className="ti ti-arrow-left" style={{fontSize: '14px'}} aria-hidden="true" />
                  <div className="term_tooltip" style={{minWidth: '160px'}}>
                    <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>
                      Previous directory
                    </div>
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
                  onClick={this.navigateForward}
                  onContextMenu={this.handleForwardContextMenu}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    cursor:
                      this.state.cwdCursor === -1 || this.state.cwdCursor >= this.state.cwdHistory.length - 1
                        ? 'default'
                        : 'pointer',
                    opacity:
                      this.state.cwdCursor === -1 || this.state.cwdCursor >= this.state.cwdHistory.length - 1 ? 0.4 : 1,
                    pointerEvents:
                      this.state.cwdCursor === -1 || this.state.cwdCursor >= this.state.cwdHistory.length - 1
                        ? 'none'
                        : 'auto'
                  }}
                >
                  <i className="ti ti-arrow-right" style={{fontSize: '14px'}} aria-hidden="true" />
                  <div className="term_tooltip" style={{minWidth: '160px'}}>
                    <div style={{fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500}}>Next directory</div>
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
              </div>
            }
            locationBar={
              <div
                ref={this.pathBarRef}
                onClick={(e) => {
                  e.stopPropagation();
                  this.toggleDirNavigator();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-4)',
                  background: 'var(--bg-primary)',
                  border: this.state.isDirNavigatorOpen
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
                title="Click to browse directories (Ctrl+Shift+O)"
              >
                <i
                  className={this.state.isDirNavigatorOpen ? 'ti ti-folder-open' : 'ti ti-folder'}
                  style={{
                    fontSize: '12px',
                    color: this.state.isDirNavigatorOpen ? 'var(--info-text)' : 'var(--text-tertiary)',
                    flexShrink: 0
                  }}
                  aria-hidden="true"
                />
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '10px',
                    color: 'var(--text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {this.props.sessionCwd || '/'}
                </span>
              </div>
            }
            onSplitRight={() => rpc.emit('split request vertical', {activeUid: this.props.uid})}
            onSplitDown={() => rpc.emit('split request horizontal', {activeUid: this.props.uid})}
            onClose={() => {
              if (this.props.onClosePane && this.props.groupUid) {
                this.props.onClosePane(this.props.groupUid);
              }
            }}
            onClick={isPicker ? undefined : this.toggleProfileMenu}
            onContextMenu={this.handlePaneBandContextMenu}
            height="compact"
          />
        )}
        {this.state.isDirNavigatorOpen && (
          <div
            ref={this.dirNavigatorRef}
            tabIndex={0}
            onKeyDown={this.handleNavigatorKeyDown}
            className="term_dirNavigatorPopup"
            style={{
              position: 'absolute',
              top: '24px',
              left: `${this.state.navigatorLeft}px`,
              width: `${this.state.navigatorWidth}px`,
              background: 'var(--bg-secondary)',
              border: '0.5px solid var(--border-neutral)',
              borderRadius: '4px',
              zIndex: 2000,
              display: 'flex',
              flexDirection: 'column',
              boxSizing: 'border-box',
              outline: 'none'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Breadcrumbs Header */}
            {this.renderNavigatorBreadcrumbs()}

            {/* Directory list */}
            {this.renderNavigatorDirectoryList()}

            {/* Footer */}
            {this.renderNavigatorFooter()}
          </div>
        )}
        {isPicker ? (
          <div className="term_pickerContainer">
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '20px 16px',
                gap: '14px',
                width: '100%'
              }}
            >
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-sans)'
                }}
              >
                Pick a shell or enter a URL
              </div>

              <div style={{display: 'flex', flexDirection: 'column', width: '100%', maxWidth: '280px'}}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    background: 'var(--bg-primary)',
                    border: '0.5px solid var(--border-neutral)',
                    borderRadius: '6px',
                    padding: '0 10px',
                    height: '36px',
                    width: '100%',
                    boxSizing: 'border-box'
                  }}
                >
                  <i
                    className="ti ti-world"
                    style={{fontSize: '14px', color: 'var(--text-tertiary)', flexShrink: 0}}
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    style={{
                      flex: 1,
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      color: 'var(--text-primary)',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      height: '100%',
                      padding: 0
                    }}
                    placeholder="https://…"
                    value={this.state.urlInput || ''}
                    onChange={(e) => this.setState({urlInput: e.target.value, urlError: ''})}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        this.submitUrl();
                      }
                    }}
                  />
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '11px',
                      padding: '1px 5px',
                      border: '0.5px solid var(--border-neutral)',
                      borderRadius: '3px',
                      color: 'var(--text-tertiary)',
                      userSelect: 'none',
                      lineHeight: '1.2'
                    }}
                  >
                    ↵
                  </span>
                </div>
                {this.state.urlError && (
                  <div
                    style={{
                      fontSize: '11px',
                      color: '#ff3b30',
                      marginTop: '4px',
                      textAlign: 'left',
                      fontFamily: 'var(--font-sans)'
                    }}
                  >
                    {this.state.urlError}
                  </div>
                )}
              </div>

              <div style={{display: 'flex', alignItems: 'center', gap: '10px', width: '100%', maxWidth: '280px'}}>
                <div style={{flex: 1, height: '0.5px', background: 'var(--border-neutral)'}} />
                <div style={{fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)'}}>
                  or pick a shell
                </div>
                <div style={{flex: 1, height: '0.5px', background: 'var(--border-neutral)'}} />
              </div>

              <div className="term_pickerGrid_rev">
                {((this.props as any).profiles || []).map((p: any) => {
                  const profileNameLower = p.name.toLowerCase();
                  let iconClass = 'ti ti-terminal-2';
                  if (profileNameLower.includes('powershell') || profileNameLower.includes('pwsh'))
                    iconClass = 'ti ti-terminal-2';
                  else if (
                    profileNameLower.includes('wsl') ||
                    profileNameLower.includes('ubuntu') ||
                    profileNameLower.includes('debian')
                  )
                    iconClass = 'ti ti-brand-debian';
                  else if (profileNameLower.includes('bash') || profileNameLower.includes('git'))
                    iconClass = 'ti ti-brand-git';
                  else if (profileNameLower.includes('cmd') || profileNameLower.includes('command'))
                    iconClass = 'ti ti-terminal';
                  else if (profileNameLower.includes('azure') || profileNameLower.includes('cloud'))
                    iconClass = 'ti ti-cloud';

                  const displayName = p.name.charAt(0).toUpperCase() + p.name.slice(1);

                  return (
                    <button
                      key={p.name}
                      className="term_pickerButton_rev"
                      onClick={() => {
                        this.handleShellProfileSelect(p);
                      }}
                    >
                      <i className={iconClass} style={{fontSize: '14px'}} aria-hidden="true" />
                      <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                        {displayName}
                      </span>
                    </button>
                  );
                })}
                <button
                  className="term_pickerButton_rev"
                  onClick={() => {
                    const port = process.env.HYPERIA_PORT || '9800';
                    const shellUrl = `http://localhost:${port}/shell`;
                    const {groupUid, uid, switchPaneToWeb} = this.props as any;
                    if (switchPaneToWeb && groupUid) {
                      switchPaneToWeb(groupUid, uid, shellUrl);
                    }
                  }}
                >
                  <i className="ti ti-robot" style={{fontSize: '14px'}} aria-hidden="true" />
                  <span>Hyperia Shell</span>
                </button>
                <button
                  className="term_pickerButton_rev term_pickerButton_custom_rev"
                  onClick={() => {
                    try {
                      ipcRenderer.send('edit-config-external');
                    } catch (err) {
                      console.error(err);
                    }
                  }}
                >
                  <i className="ti ti-plus" style={{fontSize: '14px'}} aria-hidden="true" />
                  <span>Custom…</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div
            ref={this.onTermWrapperRef}
            className={'term_fit term_wrapper ' + (this.state.isDirNavigatorOpen ? 'term_dimmed' : '')}
          />
        )}

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
                      e.preventDefault();
                      e.stopPropagation();
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
                {((this.props as any).profiles || []).map((p: any) => {
                  const isDefault = p.name === (this.props as any).defaultProfile;
                  const isCurrent = p.name === (this.props as any).sessionProfile;
                  return (
                    <div
                      key={p.name}
                      className={`term_menuOption ${isCurrent ? 'term_menuOptionActive' : ''}`}
                      onClick={() => this.handleShellProfileSelect(p)}
                      onContextMenu={(e) => this.handleRightClickProfile(e, p.name)}
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
        {this.props.customChildren}
        {this.props.search ? (
          <SearchBox
            next={this.searchNext}
            prev={this.searchPrevious}
            close={this.closeSearchBox}
            caseSensitive={this.state.searchOptions.caseSensitive}
            wholeWord={this.state.searchOptions.wholeWord}
            regex={this.state.searchOptions.regex}
            results={this.state.searchResults}
            toggleCaseSensitive={() =>
              this.setState({
                ...this.state,
                searchOptions: {
                  ...this.state.searchOptions,
                  caseSensitive: !this.state.searchOptions.caseSensitive
                }
              })
            }
            toggleWholeWord={() =>
              this.setState({
                ...this.state,
                searchOptions: {
                  ...this.state.searchOptions,
                  wholeWord: !this.state.searchOptions.wholeWord
                }
              })
            }
            toggleRegex={() =>
              this.setState({
                ...this.state,
                searchOptions: {
                  ...this.state.searchOptions,
                  regex: !this.state.searchOptions.regex
                }
              })
            }
            selectionColor={this.props.selectionColor}
            backgroundColor={this.props.backgroundColor}
            foregroundColor={this.props.foregroundColor}
            borderColor={this.props.borderColor}
            font={this.props.uiFontFamily}
          />
        ) : null}

        <style jsx global>{`
          .term_fit {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            background: var(--bg-primary);
            box-sizing: border-box;
          }

          .term_wrapper {
            flex: 1 1 0%;
            width: 100%;
            min-height: 0;
            position: relative;
            overflow: hidden;
            box-sizing: border-box;
          }

          /* Thin dark scrollbar */
          .term_wrapper .xterm-viewport {
            scrollbar-width: thin;
            scrollbar-color: var(--border-neutral) transparent;
          }
          .term_wrapper .xterm-viewport::-webkit-scrollbar {
            width: 5px;
          }
          .term_wrapper .xterm-viewport::-webkit-scrollbar-track {
            background: transparent;
          }
          .term_wrapper .xterm-viewport::-webkit-scrollbar-thumb {
            background: var(--border-neutral);
            border-radius: 10px;
          }



          .term_pickerContainer {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: var(--bg-primary);
            padding: 20px;
            box-sizing: border-box;
          }

          .term_pickerGrid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 6px;
            width: 100%;
            max-width: 520px;
            margin-bottom: 16px;
          }

          .term_pickerButton {
            padding: 8px 10px;
            font-size: 11px;
            font-family: var(--font-sans);
            font-weight: var(--weight-medium);
            color: var(--text-primary);
            background: var(--bg-secondary);
            border: 0.5px solid var(--border-neutral);
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition:
              background 0.15s ease,
              border-color 0.15s ease;
          }

          .term_pickerButton:hover {
            background: var(--info-bg);
            border-color: var(--border-focus);
            color: var(--text-primary);
          }

          .term_pickerButton_custom {
            color: var(--info-text);
          }

          .term_pickerCheckboxLabel {
            font-size: 11px;
            font-family: var(--font-sans);
            color: var(--text-tertiary);
            display: flex;
            align-items: center;
            gap: 6px;
            user-select: none;
            cursor: pointer;
          }

          .term_pickerGrid_rev {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 6px;
            width: 100%;
            max-width: 280px;
          }

          .term_pickerButton_rev {
            padding: 8px 10px;
            font-size: 11px;
            font-family: var(--font-sans);
            font-weight: 500;
            color: var(--text-primary);
            background: var(--bg-secondary);
            border: 0.5px solid var(--border-neutral);
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition:
              background 0.15s ease,
              border-color 0.15s ease;
            box-sizing: border-box;
            width: 100%;
            min-height: 32px;
          }

          .term_pickerButton_rev:hover {
            background: var(--info-bg);
            border-color: var(--border-focus);
            color: var(--text-primary);
          }

          .term_pickerButton_custom_rev {
            color: var(--info-text);
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

          .term_dirNavigatorPopup {
            box-shadow: none !important;
          }

          .term_navigatorDirRow:hover {
            background: var(--bg-primary);
          }

          .term_navigatorDirRow:hover .term_folderIcon,
          .term_navigatorDirRow:hover .term_chevronIcon {
            color: var(--text-secondary) !important;
          }

          .term_navigatorDirRow:hover .term_dirLabel {
            color: var(--text-primary) !important;
          }

          .term_breadcrumbHop:hover {
            color: var(--text-primary) !important;
            text-decoration: underline;
          }

          .term_dimmed {
            opacity: 0.35;
            filter: grayscale(40%);
            pointer-events: none;
            transition: opacity 0.15s ease;
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

          .term_paneRenameInput {
            background: rgba(0, 0, 0, 0.2);
            border: 0.5px solid var(--border-neutral);
            border-radius: var(--radius-3);
            color: var(--text-primary);
            font-size: 11px;
            padding: 0px var(--space-4);
            outline: none;
            width: 120px;
            height: 16px;
            line-height: 16px;
            font-family: var(--font-sans);
          }
          .term_paneRenameInput:focus {
            border-color: var(--info-text);
          }
        `}</style>
      </div>
    );
  }
}
