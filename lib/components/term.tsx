import {clipboard, shell, ipcRenderer} from 'electron';
import React from 'react';

import Color from 'color';
import isEqual from 'lodash/isEqual';
import pickBy from 'lodash/pickBy';
import throttle from 'lodash/throttle';
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
import {toNavigableUrl} from '../utils/navigable-url';
import {translatePath} from '../utils/path-translate';
import {countPathHorizontalStacks} from '../utils/term-groups';

import FindBar from './find-bar';
import {NewPanePicker} from './new-pane-picker';
import {PaneBand} from './pane-band';

const path = require('path');

import 'xterm/css/xterm.css';

export const activeTerminals = new Map<string, Term>();

const isWindows = ['Windows', 'Win16', 'Win32', 'WinCE'].includes(navigator.platform) || process.platform === 'win32';

// A profile's shell path reveals its OS: Windows shells use .exe / backslashes /
// drive letters, Unix shells are absolute /paths. A config synced between
// machines can carry a Windows profile (WSL, cmd, pwsh) onto a Mac (or vice
// versa) — hide profiles whose shell belongs to the other platform so the
// picker only shows shells that can actually run here.
const profileFitsPlatform = (p: any): boolean => {
  const shell = String(p?.config?.shell || '');
  if (!shell) return true;
  const looksWindows = /\.exe$|\\|^[A-Za-z]:/.test(shell);
  return isWindows ? looksWindows : !looksWindows;
};

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

interface SubdirInfo {
  name: string;
  count: number;
}

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
    useForFutureSplits?: boolean;
    isRenamingLabel?: boolean;
    renameLabelValue?: string;
    urlInput?: string;
    urlError?: string;
    cwdHistory: string[];
    cwdCursor: number;
    isDirNavigatorOpen: boolean;
    navigatorDirs: (string | SubdirInfo)[];
    navigatorCurrentPath: string;
    searchBuffer: string;
    focusedIndex: number;
    navigatorLeft: number;
    navigatorWidth: number;
    navigatorTop: number;
    isGlimmerActive?: boolean;
    showCopied?: boolean;
    // Pixel offset (within term_fit) to anchor the "Copied!" toast under the
    // clear-buffer button. Undefined until measured on first copy.
    copiedPos?: {left: number; top: number};
    isNarrow: boolean;
    paneWidth: number;
    pickerZoom: number;
    findText: string;
    activeProgram: string | null;
    customCommandInput: string;
    navigatorStatus?: string | null;
    newEnvKey: string;
    newEnvVal: string;
    isCustomModalOpen: boolean;
    customKind: 'shell' | 'agent';
    profileName: string;
    shellPath: string;
    shellArgs: string;
    envVars: {key: string; val: string}[];
  }
> {
  termRef: HTMLElement | null;
  termWrapperRef: HTMLElement | null;
  termOptions: ITerminalOptions;
  disposableListeners: IDisposable[];
  defaultBellSound: HTMLAudioElement | null;
  pendingCdPath?: string;
  bellSound: HTMLAudioElement | null;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  static rendererTypes: Record<string, string>;
  term!: Terminal;
  resizeObserver!: ResizeObserver;
  resizeTimeout!: NodeJS.Timeout;
  stabilizeResizeTimeout!: NodeJS.Timeout;
  dprMediaQuery!: MediaQueryList;
  dprUpdateHandler!: () => void;
  searchDecorations: ISearchDecorationOptions;
  searchBufferTimeout: NodeJS.Timeout | null = null;
  lastSelection = '';
  lastSelectionTime = 0;
  state = {
    searchOptions: {
      caseSensitive: false,
      wholeWord: false,
      regex: false
    },
    searchResults: undefined,
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
    navigatorDirs: [] as (string | SubdirInfo)[],
    navigatorCurrentPath: '',
    searchBuffer: '',
    focusedIndex: -1,
    navigatorLeft: 95,
    navigatorWidth: 280,
    navigatorTop: 38,
    isGlimmerActive: false,
    showCopied: false,
    copiedPos: undefined as {left: number; top: number} | undefined,
    isNarrow: false,
    paneWidth: 999,
    findText: '',
    pickerZoom: 1.0,
    activeProgram: null as string | null,
    navigatorStatus: null as string | null,
    customCommandInput: '',
    newEnvKey: '',
    newEnvVal: '',
    isCustomModalOpen: false,
    customKind: 'shell' as 'shell' | 'agent',
    profileName: '',
    shellPath: '',
    shellArgs: '',
    envVars: [] as {key: string; val: string}[]
  };

  labelRef = React.createRef<HTMLDivElement>();
  inputRef = React.createRef<HTMLInputElement>();
  dirNavigatorRef = React.createRef<HTMLDivElement>();
  pathBarRef = React.createRef<HTMLDivElement>();
  navigatorSearchInputRef = React.createRef<HTMLInputElement>();
  findInputRef = React.createRef<HTMLInputElement>();
  termOuterRef = React.createRef<HTMLDivElement>();

  handleOutsideClick = (e: MouseEvent) => {
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

  handleLabelDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const splitLabel = this.props.splitLabel;
    const customTitle = (this.props as any).sessionTitle;
    const sessionTabName = (this.props as any).sessionTabName;
    const sessionManualTitle = (this.props as any).sessionManualTitle;
    const isDefaultTitle =
      !sessionManualTitle &&
      (!customTitle ||
        ['zsh', 'bash', 'sh', 'cmd', 'powershell', 'pwsh', 'wsl', 'node', 'tmux', 'Untitled'].some((t) =>
          customTitle.toLowerCase().includes(t)
        ) ||
        customTitle.includes('/') ||
        customTitle.includes('\\'));
    const labelText = sessionTabName || (isDefaultTitle ? `Pane ${splitLabel}` : customTitle);
    this.setState({
      isRenamingLabel: true,
      renameLabelValue: labelText
    });
  };

  handlePaneBandContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const isPicker = (this.props as any).sessionProfile === 'picker';
    let isSplitDownDisabled = false;
    if (this.props.groupUid && (this.props as any).allTermGroups) {
      const stacks = countPathHorizontalStacks(this.props.groupUid, (this.props as any).allTermGroups);
      if (stacks >= 11) {
        isSplitDownDisabled = true;
      }
    }

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
          rpc.emit('split request vertical', {activeUid: this.props.uid});
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
          rpc.emit('split request horizontal', {activeUid: this.props.uid});
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
        registerAccelerator: false,
        enabled: !isSplitDownDisabled,
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
            renameLabelValue: (this.props as any).sessionTitle || `Pane ${this.props.splitLabel}`
          });
        }
      })
    );

    menu.append(new MenuItem({type: 'separator'}));

    const termGroup = (this.props as any).allTermGroups?.[this.props.groupUid!];
    const isPoppable = termGroup && !!termGroup.parentUid;

    if (isPoppable) {
      menu.append(
        new MenuItem({
          label: 'Move Pane to New Tab',
          click: () => {
            if (this.props.onPopOutPane && this.props.groupUid) {
              this.props.onPopOutPane(this.props.groupUid);
            }
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
          if (this.props.onClosePane && this.props.groupUid) {
            this.props.onClosePane(this.props.groupUid);
          }
        }
      })
    );

    menu.popup();
  };

  submitUrl = (override?: string) => {
    const trimmed = (override !== undefined ? override : this.state.urlInput || '').trim();
    if (!trimmed) return;

    // Same smart routing the web pane uses: real URLs pass through, loopback
    // gets http://, dotted/host-like tokens get https://, and free text becomes
    // a DuckDuckGo search — so the box always resolves to something navigable.
    const finalUrl = toNavigableUrl(trimmed);
    const {groupUid, uid, setWebPaneUrl} = this.props as any;
    if (setWebPaneUrl && groupUid) {
      rpc.emit('exit', {uid});
      setWebPaneUrl(groupUid, finalUrl);
    }
    this.setState({urlInput: '', urlError: ''});
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
    activeTerminals.set(props.uid, this);

    rpc.on('picker-zoom-in', this.handlePickerZoomIn);
    rpc.on('picker-zoom-out', this.handlePickerZoomOut);
    rpc.on('picker-zoom-reset', this.handlePickerZoomReset);
    rpc.on('session-cd-reply', this.handleSessionCdReply);

    this.termOptions = getTermOptions(props);
    this.term = props.term || new Terminal(this.termOptions);
    this.term.onSelectionChange(() => {
      if (this.term.hasSelection()) {
        this.lastSelection = this.term.getSelection();
        this.lastSelectionTime = Date.now();
      }
    });
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
      const handleFocus = () => {
        this.forceReflow();
        props.onActive();
      };
      this.term.textarea?.addEventListener('focus', handleFocus);
      this.disposableListeners.push({
        dispose: () => this.term.textarea?.removeEventListener('focus', handleFocus)
      });
    }

    this.disposableListeners.push(
      this.term.onData((data) => {
        if (this.props.onData) {
          if (this.props.disableMouseReporting && (data.startsWith('\x1b[M') || data.startsWith('\x1b[<'))) {
            return;
          }
          this.props.onData(data);
        }
        this.checkActiveProgram();
      })
    );

    this.disposableListeners.push(
      this.term.onLineFeed(() => {
        this.checkActiveProgram();
      })
    );

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
          this.checkActiveProgram();
        })
      );
    } else {
      this.disposableListeners.push(
        this.term.onCursorMove(() => {
          this.checkActiveProgram();
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

    window.addEventListener('resize', this.onWindowResize);
    rpc.on('move', this.onWindowMove);

    this.dprUpdateHandler = () => {
      this.forceReflow();
      if (this.dprMediaQuery && this.dprUpdateHandler) {
        this.dprMediaQuery.removeEventListener('change', this.dprUpdateHandler);
      }
      this.dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      this.dprMediaQuery.addEventListener('change', this.dprUpdateHandler);
    };
    this.dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprMediaQuery.addEventListener('change', this.dprUpdateHandler);

    terms[this.props.uid] = this;

    const outerEl = this.termOuterRef.current;
    if (outerEl) {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          const width = Math.round(entry.contentRect.width);
          // Same collapse contract as the web pane: isNarrow (split actions)
          // flips at <400; the dir bar floors/hides off paneWidth in render.
          const isNarrow = width < 400;
          if (isNarrow !== this.state.isNarrow || width !== this.state.paneWidth) {
            this.setState({isNarrow, paneWidth: width});
          }
        }
        if (this.termWrapperRef) {
          clearTimeout(this.resizeTimeout);
          this.resizeTimeout = setTimeout(() => {
            this.fitResize();
          }, 30);

          clearTimeout(this.stabilizeResizeTimeout);
          this.stabilizeResizeTimeout = setTimeout(() => {
            this.fitResize();
          }, 250);
        }
      });
      this.resizeObserver.observe(outerEl);
    }
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

  handleImagePaste = async (img: any) => {
    try {
      const pngBuffer = img.toPNG();
      if (!pngBuffer || pngBuffer.length === 0) return;

      const blob = new Blob([pngBuffer], {type: 'image/png'});
      const port = process.env.HYPERIA_PORT || '9800';

      const response = await fetch(`http://localhost:${port}/api/ghost/asset`, {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-filename': `pasted-${Date.now()}.png`
        },
        body: blob
      });

      if (!response.ok) {
        console.error('[term] Image upload to AssetStore failed with status', response.status);
        return;
      }

      const meta = await response.json();
      if (!meta?.id) {
        console.error('[term] Invalid AssetMeta returned from sidecar', meta);
        return;
      }

      // Construct canonical Windows host path
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const pathSeparator = process.platform === 'win32' ? '\\' : '/';
      const ext = '.png';
      const hostPath = [home, '.hyperia', 'assets', `${meta.id}${ext}`].join(pathSeparator);

      // Resolve profile and its pathTranslate configuration
      const profileName = (this.props as any).sessionProfile;
      const profiles = (this.props as any).profiles || [];
      const currentProfile = profiles.find((p: any) => p.name === profileName);
      const pathTranslate = currentProfile?.config?.pathTranslate;

      // Translate host path
      const translated = translatePath(hostPath, pathTranslate);

      // Paste translated path to xterm
      this.term.paste(translated);
    } catch (err) {
      console.error('[term] Error in handleImagePaste:', err);
    }
  };

  // intercepting paste event for any necessary processing of
  // clipboard data, if result is falsy, paste event continues
  onWindowPaste = (e: Event) => {
    if (!this.props.isTermActive) return;

    const formats = clipboard.availableFormats();
    const hasImage = formats.some((f) => f.startsWith('image/')) || !clipboard.readImage().isEmpty();
    if (hasImage) {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        e.preventDefault();
        e.stopPropagation();
        void this.handleImagePaste(img);
        return;
      }
    }

    const processed = processClipboard();
    if (processed) {
      e.preventDefault();
      e.stopPropagation();
      this.term.paste(processed);
    }
  };

  _copiedTimer: ReturnType<typeof setTimeout> | null = null;
  _clearBtnRef = React.createRef<HTMLSpanElement>();
  // Flash a "Copied!" toast under the clear-buffer button when text hits the
  // clipboard. Its left edge lines up with the button's left edge (the button
  // sits in the nav cluster, whose x shifts with the pane name) so it always
  // lands directly under the button rather than at a fixed corner.
  flashCopied = () => {
    let copiedPos: {left: number; top: number} | undefined;
    const btn = this._clearBtnRef.current;
    const outer = this.termOuterRef.current;
    if (btn && outer) {
      const b = btn.getBoundingClientRect();
      const o = outer.getBoundingClientRect();
      copiedPos = {left: b.left - o.left, top: b.bottom - o.top + 4};
    }
    this.setState({showCopied: true, copiedPos});
    if (this._copiedTimer) clearTimeout(this._copiedTimer);
    this._copiedTimer = setTimeout(() => this.setState({showCopied: false}), 1100);
  };

  onMouseUp = (e: React.MouseEvent) => {
    if (this.props.quickEdit && e.button === 2) {
      if (this.term.hasSelection()) {
        clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
        this.flashCopied();
      } else {
        document.execCommand('paste');
      }
    } else if (this.props.copyOnSelect && this.term.hasSelection()) {
      clipboard.writeText(this.term.getSelection());
      this.flashCopied();
    }
  };

  write(data: string | Uint8Array) {
    this.term.write(data);
    this.checkActiveProgram();
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
    if (!searchTerm) return;
    try {
      this.searchAddon.findNext(searchTerm, {
        ...this.state.searchOptions,
        decorations: this.searchDecorations
      });
    } catch (err) {
      console.error('search next failed:', err);
    }
  };

  searchPrevious = (searchTerm: string) => {
    if (!searchTerm) return;
    try {
      this.searchAddon.findPrevious(searchTerm, {
        ...this.state.searchOptions,
        decorations: this.searchDecorations
      });
    } catch (err) {
      console.error('search prev failed:', err);
    }
  };

  closeSearchBox = () => {
    // Each addon call is guarded: closing the box after a search was throwing
    // an Electron error when a decoration/term was already torn down.
    try {
      this.props.onCloseSearch();
    } catch (err) {
      console.error('onCloseSearch failed:', err);
    }
    try {
      this.searchAddon.clearDecorations();
    } catch {
      /* addon may be disposed */
    }
    try {
      this.searchAddon.clearActiveDecoration();
    } catch {
      /* addon may be disposed */
    }
    this.setState((state) => ({
      ...state,
      searchResults: undefined,
      findText: ''
    }));
    try {
      this.term?.focus();
    } catch {
      /* term may be disposed */
    }
  };

  resize(cols: number, rows: number) {
    this.term.resize(cols, rows);
  }

  selectAll() {
    this.term.selectAll();
  }

  fitResize() {
    // Guard against the early-mount race: a resize/split event can fire
    // after the wrapper ref attaches but before xterm + the fit addon are
    // constructed, which would throw "Cannot read properties of undefined
    // (reading 'refresh')". Match the defensive shape used in forceReflow.
    if (!this.termWrapperRef || !this.term || !this.fitAddon) {
      return;
    }
    try {
      this.fitAddon.fit();
      this.term.refresh(0, this.term.rows - 1);
    } catch (e) {
      console.error(e);
    }
  }

  forceReflow() {
    if (!this.termWrapperRef || !this.term) return;
    try {
      const cols = this.term.cols;
      const rows = this.term.rows;
      if (cols > 0 && rows > 0) {
        this.term.resize(cols + 1, rows);
        this.term.resize(cols, rows);
      }
      this.fitAddon.fit();
      this.term.refresh(0, this.term.rows - 1);
    } catch (e) {
      console.error(e);
    }
  }

  onWindowResize = () => {
    if (this.state.isDirNavigatorOpen) {
      this.setState({isDirNavigatorOpen: false});
    }

    clearTimeout(this.resizeTimeout);
    this.resizeTimeout = setTimeout(() => {
      this.forceReflow();
    }, 100);

    clearTimeout(this.stabilizeResizeTimeout);
    this.stabilizeResizeTimeout = setTimeout(() => {
      this.forceReflow();
    }, 300);
  };

  onWindowMove = () => {
    clearTimeout(this.resizeTimeout);
    this.resizeTimeout = setTimeout(() => {
      this.forceReflow();
    }, 100);

    clearTimeout(this.stabilizeResizeTimeout);
    this.stabilizeResizeTimeout = setTimeout(() => {
      this.forceReflow();
    }, 300);
  };

  keyboardHandler = (e: any) => {
    let isSplitDownDisabled = false;
    if (this.props.groupUid && (this.props as any).allTermGroups) {
      const stacks = countPathHorizontalStacks(this.props.groupUid, (this.props as any).allTermGroups);
      if (stacks >= 11) {
        isSplitDownDisabled = true;
      }
    }

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
    // Intercept Ctrl+Shift+O to toggle the directory navigator. Bare Ctrl+O is
    // deliberately left alone — it collides with Claude Code (and nano, bash
    // operate-and-get-next, etc.) which bind it, and our screen-scrape program
    // detection (detectInteractiveProgram) is too flaky to reliably know when
    // an inline-rendering agent like Claude Code is focused, so it would steal
    // the key whenever the heuristic momentarily lost the program.
    if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'O') {
      if (!this.state.activeProgram) {
        e.preventDefault();
        this.toggleDirNavigator();
        return false;
      }
    }

    // If pane is squished/narrow, disable split right and clone right keystrokes completely
    if (this.state.isNarrow && (e.ctrlKey || e.metaKey) && e.key === '|') {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }

    // If split down limit is reached (11 stacks), disable split down and clone down keystrokes completely
    if (isSplitDownDisabled && (e.ctrlKey || e.metaKey) && (e.key === '_' || e.key === '-')) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }

    // Intercept Ctrl+Shift+D, Ctrl+Alt+Shift+D, Ctrl+Shift+|, Ctrl+Alt+Shift+|, Ctrl+Shift+_, Ctrl+Alt+Shift+_ (and Cmd equivalents on macOS) to prevent xterm from swallowing them
    const isSplitOrCloneKey =
      (e.ctrlKey || e.metaKey) &&
      (e.key === '|' || e.key === '\\' || e.key === '_' || e.key === '-' || e.key?.toLowerCase() === 'd');

    if (isSplitOrCloneKey) {
      if (isSplitDownDisabled && (e.key === '_' || e.key === '-')) {
        e.preventDefault();
        e.stopPropagation();
      }
      return false;
    }

    // Intercept Ctrl+C (when terminal has a selection) or Ctrl+Shift+C or Cmd+C (on macOS) to copy
    const isCtrlC = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key?.toLowerCase() === 'c';
    const isCtrlShiftC = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key?.toLowerCase() === 'c';
    const isCmdC = e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.key?.toLowerCase() === 'c';

    const hasActiveSelection = this.term.hasSelection();
    const hasBufferedSelection = !hasActiveSelection && this.lastSelection && (Date.now() - this.lastSelectionTime < 1000);

    if (
      (isCtrlC && (hasActiveSelection || hasBufferedSelection)) ||
      (isCtrlShiftC && (hasActiveSelection || hasBufferedSelection)) ||
      (isCmdC && (hasActiveSelection || hasBufferedSelection))
    ) {
      const textToCopy = hasActiveSelection ? this.term.getSelection() : this.lastSelection;
      clipboard.writeText(textToCopy);
      if (textToCopy) this.flashCopied();
      if (hasActiveSelection) {
        this.term.clearSelection();
      }
      this.lastSelection = '';
      this.lastSelectionTime = 0;
      e.preventDefault();
      e.stopPropagation();
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

  triggerPickerGlimmer = () => {
    this.setState({isGlimmerActive: true}, () => {
      setTimeout(() => {
        this.setState({isGlimmerActive: false});
      }, 800);
    });
  };

  isTerminalBusy = () => {
    if (this.props.shellState) {
      return this.props.shellState.state !== 'idle';
    }
    return !!this.state.activeProgram;
  };

  toggleDirNavigator = () => {
    if (this.isTerminalBusy()) return;
    const {isDirNavigatorOpen} = this.state;
    const sessionCwd = (this.props as any).sessionCwd;
    // Always open on the pane's CURRENT directory (sessionCwd), not a stale
    // browsed path. Empty → the sidecar resolves to the user's home directory.
    const activePath = sessionCwd || '';

    if (!isDirNavigatorOpen) {
      let navigatorLeft = 8;
      let navigatorWidth = 320;
      let navigatorTop = 38;

      if (this.pathBarRef.current) {
        const rect = this.pathBarRef.current.getBoundingClientRect();
        const termFit = this.pathBarRef.current.closest('.term_fit');
        if (termFit) {
          const parentRect = termFit.getBoundingClientRect();
          navigatorLeft = rect.left - parentRect.left;
          navigatorTop = rect.bottom - parentRect.top + 4; // 4px margin below the path bar

          const widthToUse = Math.min(Math.max(rect.width, 320), parentRect.width - 16);
          navigatorWidth = widthToUse;
          if (navigatorLeft + widthToUse > parentRect.width) {
            // Shift left (right-justify) if it overflows the right edge
            navigatorLeft = rect.right - parentRect.left - widthToUse;
            if (navigatorLeft < 8) {
              navigatorLeft = 8;
            }
          }
        }
      }

      this.setState(
        {
          isDirNavigatorOpen: true,
          navigatorLeft,
          navigatorWidth,
          navigatorTop
        },
        () => {
          setTimeout(() => {
            this.navigatorSearchInputRef.current?.focus();
            this.navigatorSearchInputRef.current?.select();
          }, 50);
        }
      );
      // navigatorCurrentPath / navigatorDirs / searchBuffer / focusedIndex are
      // set by loadNavigatorDirs once the sidecar responds.
      this.loadNavigatorDirs(activePath);
    } else {
      this.setState(
        {
          isDirNavigatorOpen: false,
          navigatorStatus: null
        },
        () => {
          setTimeout(() => {
            this.focus();
          }, 50);
        }
      );
    }
  };

  submitCustomCommand = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const commandLine = this.state.customCommandInput.trim();
    if (!commandLine) return;

    const profiles = (this.props as any).profiles || [];
    const defaultProfileName = (this.props as any).defaultProfile;
    const defaultProfile = profiles.find((p: any) => p.name === defaultProfileName) || profiles[0];

    const shell = defaultProfile?.config?.shell || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash');
    const shellLower = shell.toLowerCase();
    let shellArgs: string[] = [];
    if (shellLower.includes('cmd.exe')) {
      shellArgs = ['/c', commandLine];
    } else if (shellLower.includes('powershell') || shellLower.includes('pwsh')) {
      shellArgs = ['-Command', commandLine];
    } else {
      shellArgs = ['-l', '-c', commandLine];
    }

    const {groupUid, uid, sessionCwd} = this.props as any;
    rpc.emit('new', {
      isNewGroup: false,
      cwd: sessionCwd || (this.props as any).cwd,
      activeUid: uid,
      shell,
      shellArgs,
      groupUid
    });
  };

  addEnvVar = () => {
    const key = this.state.newEnvKey.trim();
    const val = this.state.newEnvVal.trim();
    if (!key) return;

    const currentEnv = {...((this.props as any).env || {})};
    currentEnv[key] = val;

    ipcRenderer.send('set-config-env', currentEnv);
    this.setState({newEnvKey: '', newEnvVal: ''});
  };

  deleteEnvVar = (key: string) => {
    const currentEnv = {...((this.props as any).env || {})};
    delete currentEnv[key];
    ipcRenderer.send('set-config-env', currentEnv);
  };

  saveCustomProfile = () => {
    const pName = this.state.profileName.trim();
    const sPath = this.state.shellPath.trim();
    if (pName && sPath) {
      const args = this.state.shellArgs
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
      const envObj: Record<string, string> = {};
      this.state.envVars.forEach((ev) => {
        envObj[ev.key] = ev.val;
      });
      ipcRenderer.send('add-profile', {
        name: pName,
        shell: sPath,
        shellArgs: args,
        env: envObj,
        kind: this.state.customKind
      });
      this.setState({
        isCustomModalOpen: false,
        customKind: 'shell',
        profileName: '',
        shellPath: '',
        shellArgs: '',
        envVars: [],
        newEnvKey: '',
        newEnvVal: ''
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
    this.setState({
      navigatorCurrentPath: targetPath,
      searchBuffer: '',
      focusedIndex: -1,
      navigatorStatus: null
    });
    fetch(`http://localhost:${port}/api/fs/dirs?path=${encodeURIComponent(targetPath)}`)
      .then((r) => r.json())
      .then((data: {path: string; parent: string | null; dirs: (string | SubdirInfo)[]}) => {
        this.setState({
          navigatorCurrentPath: data.path,
          navigatorDirs: data.dirs
        });
        // Navigating into a folder (row/breadcrumb click) blurs the search input;
        // re-focus it so the user can keep typing to filter immediately.
        if (this.state.isDirNavigatorOpen) {
          setTimeout(() => this.navigatorSearchInputRef.current?.focus(), 0);
        }
      })
      .catch((err) => {
        console.error('Failed to load directory listing:', err);
        this.setState({navigatorDirs: [] as (string | SubdirInfo)[]});
      });
  };

  // ── Recent-directory history (cross-pane, persisted) ─────────────────────
  private static DIR_HISTORY_KEY = 'hyperia_dir_history';

  private normDir = (s: string): string => s.replace(/[\\/]+$/, '').toLowerCase();

  loadDirHistory = (): string[] => {
    try {
      const raw = localStorage.getItem(Term.DIR_HISTORY_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };

  recordDirHistory = (p: string): void => {
    const path = (p || '').replace(/[\\/]+$/, '').trim() || p.trim();
    if (!path) return;
    try {
      const key = this.normDir(path);
      const prev = this.loadDirHistory().filter((x) => this.normDir(x) !== key);
      const next = [path, ...prev].slice(0, 30);
      localStorage.setItem(Term.DIR_HISTORY_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / unavailable */
    }
  };

  // A single horizontal row of quick-jump buttons under the directory list:
  // HOME first (accent color), then most-recent dirs (excluding home + the
  // currently-browsed path). Clicking browses there (ctrl-enter still cds).
  renderNavigatorRecent = () => {
    const home = (process.env.USERPROFILE || process.env.HOME || '').replace(/[\\/]+$/, '');
    const current = this.normDir(this.state.navigatorCurrentPath || '');
    const recents = this.loadDirHistory().filter(
      (p) => this.normDir(p) !== current && (!home || this.normDir(p) !== this.normDir(home))
    );

    const query = this.state.searchBuffer.toLowerCase();
    const matchesQuery = (p: string) => {
      const full = p.toLowerCase();
      const base = path.basename(p).toLowerCase();
      return full.includes(query) || base.includes(query);
    };

    const items: {path: string; accent: boolean}[] = [];
    if (query.length > 0) {
      if (home && matchesQuery(home)) {
        items.push({path: home, accent: true});
      }
      recents
        .filter(matchesQuery)
        .slice(0, 12)
        .forEach((p) => {
          items.push({path: p, accent: false});
        });
    } else {
      if (home) {
        items.push({path: home, accent: true});
      }
      recents.slice(0, 12).forEach((p) => {
        items.push({path: p, accent: false});
      });
    }

    if (items.length === 0) return null;

    return (
      <div
        style={{
          borderTop: '0.5px solid var(--border-neutral)',
          padding: 'var(--space-6) var(--space-8)'
        }}
      >
        <div
          style={{
            fontSize: '9px',
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-sans)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            marginBottom: 'var(--space-4)',
            paddingLeft: 'var(--space-4)'
          }}
        >
          recent
        </div>
        <div
          className="term_navigatorRecentRow"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-6)',
            paddingBottom: '2px'
          }}
        >
          {items.map(({path, accent}) => (
            <span
              key={path}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => this.loadNavigatorDirs(path)}
              title={accent ? `Home — ${path}` : path}
              style={{
                cursor: 'pointer',
                // Wrap onto new lines when the pane is narrow instead of
                // side-scrolling; a single over-wide path chip ellipsizes
                // (full path still on hover via title) rather than overflowing.
                maxWidth: '100%',
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                padding: '2px var(--space-6)',
                borderRadius: 'var(--radius-3)',
                border: '0.5px solid var(--border-neutral)',
                color: accent ? 'var(--info-text)' : 'var(--text-secondary)',
                background: accent ? 'var(--info-bg)' : 'var(--bg-primary)'
              }}
            >
              {path}
            </span>
          ))}
        </div>
      </div>
    );
  };

  getTerminalScreenText = (): string => {
    if (!this.term) return '';
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let r = 0; r < buffer.length; r++) {
      const line = buffer.getLine(r);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    return lines.join('\n');
  };

  detectInteractiveProgram = (screenText: string): string | null => {
    const lower = screenText.toLowerCase();
    const lines = screenText.split('\n');
    const last10Lines = lines.slice(-10).join('\n').toLowerCase();

    // Claude Code
    if (
      last10Lines.includes('claude') &&
      (last10Lines.includes('❯') || last10Lines.includes('>>') || last10Lines.includes('transmuting'))
    ) {
      return 'Claude Code';
    }
    // Codex
    if (last10Lines.includes('codex') && (last10Lines.includes('>>') || last10Lines.includes('❯'))) {
      return 'Codex';
    }
    // Python REPL
    if (last10Lines.includes('>>>') && lower.includes('python')) {
      return 'Python REPL';
    }
    // Node REPL
    if (last10Lines.includes('> ') && lower.includes('node') && !last10Lines.includes('$')) {
      return 'Node REPL';
    }
    // vim
    if (lower.includes('-- insert --') || lower.includes('-- normal --') || lower.includes('-- visual --')) {
      return 'vim';
    }
    // less/man
    const trimmedLast = last10Lines.trim();
    if (trimmedLast.endsWith(':') && (lower.includes('manual page') || lower.includes('(end)'))) {
      return 'less/man';
    }
    // nemesis8
    if (last10Lines.includes('nemesis') && last10Lines.includes('>>')) {
      return 'Nemesis8';
    }

    return null;
  };

  checkActiveProgram = throttle(() => {
    if (!this.term) return;
    let activeProgram: string | null = null;
    const screenText = this.getTerminalScreenText();
    const detected = this.detectInteractiveProgram(screenText);
    if (detected) {
      activeProgram = detected;
    } else if (this.term.buffer.active.type === 'alternate') {
      activeProgram = 'interactive program';
    }

    if (this.state.activeProgram !== activeProgram) {
      this.setState({activeProgram});
    }
  }, 200);

  // The ONLY place that actually changes the shell's directory — on an explicit
  // Go, never on browse. Queued navigation lands here.
  goToNavigatorDir = () => {
    if (this.isTerminalBusy()) return;
    const target = this.state.navigatorCurrentPath;
    if (!target || !this.props.onData) return;

    this.pendingCdPath = target;
    this.setState({navigatorStatus: 'Requesting directory change...'});
    rpc.emit('session-cd', {uid: this.props.uid, path: target});
  };

  handleSessionCdReply = (data: {
    uid: string;
    applied?: boolean;
    queued?: boolean;
    refused?: boolean;
    reason?: string;
  }) => {
    if (data.uid !== this.props.uid) return;

    if (data.applied) {
      const target = this.pendingCdPath || this.state.navigatorCurrentPath;
      this.setState(
        {
          isDirNavigatorOpen: false,
          navigatorStatus: null
        },
        () => {
          if ((this.props as any).onCwd && target) {
            (this.props as any).onCwd(target);
          }
          setTimeout(() => {
            this.focus();
          }, 50);
        }
      );
    } else if (data.queued) {
      this.setState({
        navigatorStatus: 'Will change directory when program exits'
      });
    } else if (data.refused) {
      this.setState({
        navigatorStatus: `Directory change refused: ${data.reason || 'unknown'}`
      });
    }
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
          gap: 'var(--space-4)',
          padding: 'var(--space-8) var(--space-12)',
          borderBottom: '0.5px solid var(--border-neutral)'
        }}
      >
        <span
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => handleHopClick(rootPath)}
          style={{
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            color: 'var(--text-secondary)'
          }}
          title="Root directory"
        >
          <i className="ti ti-home" style={{fontSize: '13px'}} aria-hidden="true" />
        </span>
        {hops.map((hop, index) => {
          const isLast = index === hops.length - 1;
          // Windows: the separator is "\", and there is NO separator before the
          // drive (it reads "C: \ Users", not "\ C: \ Users"). Unix: "/" before
          // every hop, including root.
          const showSep = isWindows ? index > 0 : true;
          return (
            <React.Fragment key={hop.path}>
              {showSep && (
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-tertiary)',
                    fontFamily: 'var(--font-mono)'
                  }}
                >
                  {sep}
                </span>
              )}
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
                  onMouseDown={(e) => e.preventDefault()}
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
          onMouseDown={(e) => e.preventDefault()}
          className="term_navigatorGo"
          title="cd to this directory (Ctrl+Enter)"
          style={{
            marginLeft: 'auto',
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
            whiteSpace: 'nowrap'
          }}
        >
          ctrl-enter
        </span>
      </div>
    );
  };

  renderNavigatorDirectoryList = () => {
    const {navigatorDirs, navigatorCurrentPath, searchBuffer, focusedIndex} = this.state;

    const filteredDirs =
      searchBuffer.length > 0
        ? navigatorDirs.filter((dir) => {
            const name = typeof dir === 'string' ? dir : dir.name;
            return name.toLowerCase().includes(searchBuffer.toLowerCase());
          })
        : navigatorDirs;

    const handleRowClick = (dirName: string) => {
      const targetPath = path.join(navigatorCurrentPath, dirName);
      this.loadNavigatorDirs(targetPath);
    };

    if (filteredDirs.length === 0) {
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
          No matching subdirectories
        </div>
      );
    }

    return (
      <div style={{maxHeight: '220px', overflowY: 'auto'}} className="term_navigatorDirList">
        {filteredDirs.map((dir, index) => {
          const isMatched = index === focusedIndex;
          const showFocus = isMatched;
          const dirName = typeof dir === 'string' ? dir : dir.name;
          const dirCount = typeof dir === 'object' && dir !== null ? dir.count : undefined;

          let dirLabelNode: React.ReactNode = dirName;
          if (showFocus && searchBuffer.length > 0) {
            const prefixLower = searchBuffer.toLowerCase();
            const dirLower = dirName.toLowerCase();
            const matchIndex = dirLower.indexOf(prefixLower);
            if (matchIndex !== -1) {
              const beforePart = dirName.substring(0, matchIndex);
              const matchedPart = dirName.substring(matchIndex, matchIndex + prefixLower.length);
              const afterPart = dirName.substring(matchIndex + prefixLower.length);
              dirLabelNode = (
                <span
                  style={{
                    color: showFocus ? 'var(--info-text)' : 'var(--text-primary)',
                    fontWeight: showFocus ? 500 : 'normal'
                  }}
                >
                  <span>{beforePart}</span>
                  <span
                    style={{
                      textDecoration: 'underline',
                      textUnderlineOffset: '2px',
                      fontWeight: 'bold'
                    }}
                  >
                    {matchedPart}
                  </span>
                  <span>{afterPart}</span>
                </span>
              );
            }
          }

          return (
            <div
              key={dirName}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleRowClick(dirName)}
              className={`term_navigatorDirRow ${showFocus ? 'term_navigatorDirRow_focused' : ''}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: 'var(--space-6) var(--space-12)',
                cursor: 'pointer',
                background: showFocus ? 'var(--info-bg)' : undefined,
                transition: 'background 0.1s ease'
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-6)',
                  minWidth: 0,
                  flex: 1
                }}
              >
                <i
                  className="ti ti-folder term_folderIcon"
                  style={{
                    fontSize: '13px',
                    color: showFocus ? 'var(--info-text)' : 'var(--text-tertiary)',
                    flexShrink: 0
                  }}
                  aria-hidden="true"
                />
                <span
                  className="term_dirLabel"
                  style={{
                    fontSize: '11px',
                    color: showFocus ? 'var(--info-text)' : 'var(--text-primary)',
                    fontFamily: 'var(--font-sans)',
                    fontWeight: showFocus ? 500 : 'normal',
                    userSelect: 'none',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginRight: 'var(--space-6)'
                  }}
                >
                  {dirLabelNode}
                </span>
                {typeof dirCount === 'number' && !isNaN(dirCount) && (
                  <span
                    style={{
                      fontSize: '10px',
                      color: showFocus ? 'var(--info-text)' : 'var(--text-tertiary)',
                      fontFamily: 'var(--font-sans)',
                      flexShrink: 0
                    }}
                  >
                    ({dirCount} {dirCount === 1 ? 'directory' : 'directories'})
                  </span>
                )}
              </div>
              <i
                className="ti ti-chevron-right term_chevronIcon"
                style={{
                  fontSize: '11px',
                  color: showFocus ? 'var(--info-text)' : 'var(--text-tertiary)',
                  flexShrink: 0
                }}
                aria-hidden="true"
              />
            </div>
          );
        })}
      </div>
    );
  };

  handleSearchInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const {navigatorDirs} = this.state;

    const filteredDirs =
      val.length > 0
        ? navigatorDirs.filter((dir) => {
            const name = typeof dir === 'string' ? dir : dir.name;
            return name.toLowerCase().includes(val.toLowerCase());
          })
        : navigatorDirs;

    this.setState({
      searchBuffer: val,
      focusedIndex: filteredDirs.length > 0 ? 0 : -1
    });
  };

  handleSearchInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const {navigatorDirs, searchBuffer, focusedIndex, navigatorCurrentPath} = this.state;
    const key = e.key;

    const filteredDirs =
      searchBuffer.length > 0
        ? navigatorDirs.filter((dir) => {
            const name = typeof dir === 'string' ? dir : dir.name;
            return name.toLowerCase().includes(searchBuffer.toLowerCase());
          })
        : navigatorDirs;

    if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (searchBuffer.length > 0) {
        this.setState({searchBuffer: '', focusedIndex: -1});
      } else {
        this.setState(
          {
            isDirNavigatorOpen: false
          },
          () => {
            setTimeout(() => {
              this.focus();
            }, 50);
          }
        );
      }
      return;
    }

    if (key === 'Backspace' && searchBuffer.length === 0) {
      e.preventDefault();
      e.stopPropagation();
      const parentPath = path.dirname(navigatorCurrentPath);
      if (parentPath && parentPath !== navigatorCurrentPath) {
        this.loadNavigatorDirs(parentPath);
      }
      return;
    }

    if (key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (filteredDirs.length > 0) {
        const newIdx = (focusedIndex + 1) % filteredDirs.length;
        this.setState({focusedIndex: newIdx});
      }
      return;
    }

    if (key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (filteredDirs.length > 0) {
        const newIdx = focusedIndex <= 0 ? filteredDirs.length - 1 : focusedIndex - 1;
        this.setState({focusedIndex: newIdx});
      }
      return;
    }

    if (key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();

      if (e.ctrlKey) {
        this.goToNavigatorDir();
        return;
      }

      if (focusedIndex >= 0 && focusedIndex < filteredDirs.length) {
        const selected = filteredDirs[focusedIndex];
        const dirName = typeof selected === 'string' ? selected : selected.name;
        const targetPath = path.join(navigatorCurrentPath, dirName);
        this.loadNavigatorDirs(targetPath);
      } else {
        let targetPath = searchBuffer.trim();
        if (targetPath) {
          if (!path.isAbsolute(targetPath) && !targetPath.startsWith('~') && !/^[A-Za-z]:/.test(targetPath)) {
            targetPath = path.join(navigatorCurrentPath, targetPath);
          }
          this.loadNavigatorDirs(targetPath);
        }
      }
      return;
    }
  };

  renderNavigatorFooter = () => {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-8)',
          padding: 'var(--space-8) var(--space-12)',
          borderTop: '0.5px solid var(--border-neutral)',
          background: 'var(--bg-primary)',
          borderBottomLeftRadius: '4px',
          borderBottomRightRadius: '4px',
          boxSizing: 'border-box'
        }}
      >
        <i
          className="ti ti-search"
          style={{
            fontSize: '13px',
            color: 'var(--text-tertiary)',
            flexShrink: 0
          }}
          aria-hidden="true"
        />
        <input
          ref={this.navigatorSearchInputRef}
          type="text"
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--text-primary)',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            height: '24px',
            padding: 0
          }}
          placeholder="Search or enter path... (Esc to close, Ctrl+Enter to Go)"
          value={this.state.searchBuffer}
          onChange={this.handleSearchInputChange}
          onKeyDown={this.handleSearchInputKeyDown}
        />
        <span
          onClick={this.isTerminalBusy() ? undefined : this.goToNavigatorDir}
          onMouseDown={(e) => e.preventDefault()}
          style={{
            cursor: this.isTerminalBusy() ? 'not-allowed' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-4)',
            fontSize: '10px',
            fontWeight: 600,
            fontFamily: 'var(--font-mono)',
            color: this.isTerminalBusy() ? 'var(--text-secondary)' : 'var(--text-info)',
            border: '0.5px solid var(--border-neutral)',
            borderRadius: 'var(--radius-3)',
            padding: '1px var(--space-6)',
            background: 'var(--bg-secondary)',
            userSelect: 'none',
            whiteSpace: 'nowrap',
            opacity: this.isTerminalBusy() ? 0.5 : 1
          }}
          title={this.isTerminalBusy() ? "Directory change locked while process is running" : "cd to current browsed path (Ctrl+Enter)"}
        >
          ctrl-enter
        </span>
      </div>
    );
  };

  handleNavigatorKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    this.handleSearchInputKeyDown(e as any);
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
      // Persist every real cwd the shell lands in to a cross-pane recent list
      // the directory picker surfaces as quick-jump buttons.
      this.recordDirHistory(sessionCwd);
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

      // Sync shell CWD changes to directory picker if open and not manually navigated away
      if (this.state.isDirNavigatorOpen && this.state.navigatorCurrentPath === prevSessionCwd) {
        this.loadNavigatorDirs(sessionCwd);
      }
    }

    const wasActive = prevState.isDirNavigatorOpen;
    const isActive = this.state.isDirNavigatorOpen;

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
    // Find bar just opened → focus its input (mirrors the web pane).
    if (!prevProps.search && this.props.search) {
      setTimeout(() => {
        this.findInputRef.current?.focus();
        this.findInputRef.current?.select();
      }, 50);
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
      this.fitResize();
    }
  };

  componentWillUnmount() {
    (this.checkActiveProgram as any).cancel();
    activeTerminals.delete(this.props.uid);
    rpc.removeListener('picker-zoom-in', this.handlePickerZoomIn);
    rpc.removeListener('picker-zoom-out', this.handlePickerZoomOut);
    rpc.removeListener('picker-zoom-reset', this.handlePickerZoomReset);
    rpc.removeListener('session-cd-reply', this.handleSessionCdReply);

    window.removeEventListener('resize', this.onWindowResize);
    rpc.removeListener('move', this.onWindowMove);
    if (this.dprMediaQuery && this.dprUpdateHandler) {
      this.dprMediaQuery.removeEventListener('change', this.dprUpdateHandler);
    }
    clearTimeout(this.resizeTimeout);
    clearTimeout(this.stabilizeResizeTimeout);

    this.resizeObserver?.disconnect();
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

  handlePickerZoomIn = (data: {uid: string}) => {
    if (data.uid !== this.props.uid) return;
    this.setState({pickerZoom: Math.min(this.state.pickerZoom + 0.1, 3.0)});
  };

  handlePickerZoomOut = (data: {uid: string}) => {
    if (data.uid !== this.props.uid) return;
    this.setState({pickerZoom: Math.max(this.state.pickerZoom - 0.1, 0.5)});
  };

  handlePickerZoomReset = (data: {uid: string}) => {
    if (data.uid !== this.props.uid) return;
    this.setState({pickerZoom: 1.0});
  };

  getCurrentCommandLine(): string {
    if (!this.term) return '';
    try {
      const buffer = this.term.buffer.active;
      const absoluteCursorY = buffer.baseY + buffer.cursorY;
      const lines: string[] = [];

      const startY = Math.max(0, absoluteCursorY - 3);
      for (let y = absoluteCursorY; y >= startY; y--) {
        const line = buffer.getLine(y);
        if (line) {
          lines.unshift(line.translateToString(true));
        }
      }

      const fullText = lines.join('');
      const promptSymbols = ['❯', '$', '%', '#', '>'];
      let lastSymbolIndex = -1;
      let matchedSymbol = '';

      for (const sym of promptSymbols) {
        const idx = fullText.lastIndexOf(sym);
        if (idx > lastSymbolIndex) {
          lastSymbolIndex = idx;
          matchedSymbol = sym;
        }
      }

      if (lastSymbolIndex !== -1) {
        return fullText.substring(lastSymbolIndex + matchedSymbol.length).trim();
      }
    } catch (e) {
      console.error('Error extracting command line:', e);
    }
    return '';
  }

  render() {
    let isSplitDownDisabled = false;
    if (this.props.groupUid && (this.props as any).allTermGroups) {
      const stacks = countPathHorizontalStacks(this.props.groupUid, (this.props as any).allTermGroups);
      if (stacks >= 11) {
        isSplitDownDisabled = true;
      }
    }

    // Identical toolbar-collapse contract to the web pane (see web-pane.tsx):
    // splits drop below ~400 (and hand their room back to the dir bar); the dir
    // bar floors at ~11 chars and is hidden entirely below ~320 rather than
    // shrinking to a stub. End state = title + nav + close.
    const w = this.state.paneWidth;
    const hideSplits = w < 300;
    const showDirBar = w >= 240;
    // Find-bar match counts (xterm reports a 0-based resultIndex).
    const sr = this.state.searchResults as {resultIndex: number; resultCount: number} | undefined;
    const findActive = sr ? sr.resultIndex + 1 : 0;
    const findTotal = sr ? sr.resultCount : 0;

    const splitLabel = this.props.splitLabel;
    const customTitle = (this.props as any).sessionTitle;
    const sessionTabName = (this.props as any).sessionTabName;
    const sessionManualTitle = (this.props as any).sessionManualTitle;
    const sessionProfile = (this.props as any).sessionProfile;
    const sessionShellName = (this.props as any).sessionShellName;
    const isPicker = sessionProfile === 'picker';
    const shellType = isPicker ? 'Chooser' : sessionProfile || 'Shell';
    // Priority:
    //   1. Picker → "Chooser" (with codename if present).
    //   2. A real OSC title from the process (claude, etc.) — wins over the
    //      auto-generated codename so `claude` showing up as "claude (opus
    //      4.7)" overrides "Shell (Whispering Capybara)".
    //   3. The cute auto-generated codename → "Shell (Whispering Capybara)".
    //   4. Bare fallback → "Pane a".
    const JUNK_TITLE_TOKENS = ['zsh', 'bash', 'sh', 'cmd', 'powershell', 'pwsh', 'wsl', 'node', 'tmux', 'Untitled'];
    const isRealOscTitle =
      sessionManualTitle ||
      (!!customTitle &&
        !JUNK_TITLE_TOKENS.some((t) => customTitle.toLowerCase().includes(t)) &&
        !customTitle.includes('/') &&
        !customTitle.includes('\\'));
    const labelText = isPicker
      ? 'new pane'
      : sessionTabName
        ? sessionTabName
        : isRealOscTitle
          ? customTitle
          : sessionShellName
            ? `${shellType} (${sessionShellName})`
            : `Pane ${splitLabel}`;

    const labelFull = isPicker
      ? 'new pane'
      : !isPicker && sessionShellName
        ? `${sessionShellName} | ${shellType}`
        : labelText;
    const labelShort = isPicker ? 'new pane' : sessionShellName ? sessionShellName : labelText;

    const nameLower = (sessionProfile || '').toLowerCase();
    // Terminal panes show the classic ">_" shell-prompt glyph (rendered mono in
    // the band) instead of per-shell emojis. Agents (claude) keep a distinct
    // marker; the new-pane picker keeps its gear.
    let icon = isPicker ? '⚙️' : '>_';
    if (nameLower.includes('claude')) icon = '🤖';

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

    const allTermGroups = (this.props as any).allTermGroups || {};
    const groupUid = this.props.groupUid || '';
    const startIdx = getStartIdx(allTermGroups, groupUid);

    const tint = isPicker ? 'picker' : getPaneTint(startIdx, splitLabel);
    const showLabelStrip = !!splitLabel || isPicker;

    return (
      <div
        ref={this.termOuterRef}
        className={`term_fit ${this.props.isTermActive ? 'term_active' : ''}`}
        onMouseUp={this.onMouseUp}
        style={{position: 'relative'}}
      >
        {this.state.showCopied && (
          <div
            style={{
              position: 'absolute',
              // Anchored under the clear-buffer button (left edges aligned); falls
              // back to the top-right corner if the button wasn't measured.
              ...(this.state.copiedPos
                ? {left: this.state.copiedPos.left, top: this.state.copiedPos.top}
                : {top: 40, right: 12}),
              zIndex: 50,
              pointerEvents: 'none',
              textAlign: 'left',
              whiteSpace: 'nowrap',
              background: 'var(--accent-success, #3fb950)',
              color: '#06140a',
              fontSize: '11px',
              fontWeight: 600,
              padding: '4px 10px',
              borderRadius: '6px',
              fontFamily: 'var(--font-sans)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.35)'
            }}
          >
            Copied!
          </div>
        )}
        {this.props.customChildrenBefore}
        {showLabelStrip && (
          <PaneBand
            ref={this.labelRef}
            paneType="shell"
            paneId={this.props.uid}
            tint={isPicker ? 'neutral' : (tint as any)}
            isPlaceholder={isPicker}
            isSplitRightDisabled={hideSplits}
            isSplitDownDisabled={isSplitDownDisabled || hideSplits}
            isBusy={this.isTerminalBusy()}
            paneName={labelFull}
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
                <span onDoubleClick={this.handleLabelDoubleClick}>
                  <span className="term_labelFull">{labelFull}</span>
                  <span className="term_labelShort">{labelShort}</span>
                </span>
              )
            }
            icon={<span style={{fontFamily: 'var(--font-mono)', fontWeight: 700}}>{icon}</span>}
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
                    <div
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-primary)',
                        fontWeight: 500
                      }}
                    >
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
                    <div
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-primary)',
                        fontWeight: 500
                      }}
                    >
                      Next directory
                    </div>
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
                <span
                  ref={this._clearBtnRef}
                  className="term_controlIcon term_tooltipTrigger"
                  onClick={() => {
                    this.clear();
                    this.focus();
                  }}
                  style={{display: 'flex', alignItems: 'center', cursor: 'pointer'}}
                >
                  <i className="ti ti-clear-all" style={{fontSize: '14px'}} aria-hidden="true" />
                  <div className="term_tooltip" style={{minWidth: '160px'}}>
                    <div
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-primary)',
                        fontWeight: 500
                      }}
                    >
                      Clear buffer
                    </div>
                    <div
                      style={{
                        fontSize: '11px',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-secondary)',
                        marginTop: 'var(--space-2)'
                      }}
                    >
                      Wipe scrollback — shell only, not TUIs
                    </div>
                  </div>
                </span>
              </div>
            }
            locationBar={
              showDirBar ? (
                <div
                  ref={this.pathBarRef}
                  className="term_locationBar"
                  onClick={(e) => {
                    e.stopPropagation();
                    this.toggleDirNavigator();
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
                    // Fill the row; hard floor ~11 chars; hidden (not stubbed)
                    // below ~320 via showDirBar. Matches the web-pane URL bar.
                    flex: 1,
                    minWidth: '80px',
                    cursor: this.isTerminalBusy() ? 'not-allowed' : 'pointer',
                    opacity: this.isTerminalBusy() ? 0.5 : 1,
                    boxSizing: 'border-box',
                    marginLeft: 'var(--space-4)',
                    marginRight: 'var(--space-8)'
                  }}
                  title={
                    this.isTerminalBusy()
                      ? `Directory browsing locked while a process is running`
                      : 'Click to browse directories (Ctrl+Shift+O)'
                  }
                >
                  <i
                    className={
                      this.isTerminalBusy()
                        ? 'ti ti-lock'
                        : this.state.isDirNavigatorOpen
                          ? 'ti ti-folder-open'
                          : 'ti ti-folder'
                    }
                    style={{
                      fontSize: '12px',
                      color: 'var(--info-text)',
                      flexShrink: 0
                    }}
                    aria-hidden="true"
                  />
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '11px',
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {this.state.isDirNavigatorOpen
                      ? this.state.navigatorCurrentPath || '/'
                      : this.props.sessionCwd || '/'}
                  </span>
                </div>
              ) : null
            }
            onSplitRight={() => rpc.emit('split request vertical', {activeUid: this.props.uid})}
            onSplitDown={() =>
              rpc.emit('split request horizontal', {
                activeUid: this.props.uid
              })
            }
            onSplitLeft={() => rpc.emit('split request vertical', {activeUid: this.props.uid, splitPlacement: 'BEFORE'})}
            onSplitUp={() => rpc.emit('split request horizontal', {activeUid: this.props.uid, splitPlacement: 'BEFORE'})}
            onClose={() => {
              if (this.props.onClosePane && this.props.groupUid) {
                this.props.onClosePane(this.props.groupUid);
              }
            }}
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
              top: `${this.state.navigatorTop}px`,
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

            {/* Recent dirs — quick-jump button row */}
            {this.renderNavigatorRecent()}

            {/* Status bar */}
            {this.state.navigatorStatus && (
              <div
                style={{
                  padding: '6px var(--space-12)',
                  fontSize: '10px',
                  color: this.state.navigatorStatus.startsWith('Directory change refused')
                    ? 'var(--danger-text)'
                    : 'var(--info-text)',
                  fontFamily: 'var(--font-sans)',
                  borderTop: '0.5px solid var(--border-neutral)',
                  background: 'var(--bg-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <i
                  className={
                    this.state.navigatorStatus.startsWith('Directory change refused')
                      ? 'ti ti-alert-triangle'
                      : 'ti ti-clock'
                  }
                  style={{fontSize: '11px'}}
                  aria-hidden="true"
                />
                <span style={{fontWeight: 500}}>{this.state.navigatorStatus}</span>
              </div>
            )}

            {/* Footer */}
            {this.renderNavigatorFooter()}
          </div>
        )}
        {isPicker ? (
          <NewPanePicker
            profiles={(this.props as any).profiles}
            defaultProfile={(this.props as any).defaultProfile}
            groupUid={(this.props as any).groupUid}
            uid={(this.props as any).uid}
            sessionCwd={(this.props as any).sessionCwd}
            cwd={(this.props as any).cwd}
            setWebPaneUrl={(this.props as any).setWebPaneUrl}
            urlInput={this.state.urlInput}
            urlError={this.state.urlError}
            pickerZoom={this.state.pickerZoom}
            isGlimmerActive={this.state.isGlimmerActive}
            onUrlChange={(v) => this.setState({urlInput: v, urlError: ''})}
            onSubmitUrl={(url) => this.submitUrl(url)}
            onTriggerGlimmer={() => this.triggerPickerGlimmer()}
            onOpenCustomModal={(kind) => this.setState({isCustomModalOpen: true, customKind: kind})}
          />
        ) : (
          <div
            ref={this.onTermWrapperRef}
            className={'term_fit term_wrapper ' + (this.state.isDirNavigatorOpen ? 'term_dimmed' : '')}
          />
        )}

        {this.state.isCustomModalOpen && (
          <div
            // In-pane, not a full-screen overlay: fills the pane BELOW the pane
            // band (keeps the "new pane" top bar visible) and covers the picker
            // buttons + URL bar. Back returns to them.
            style={{
              position: 'absolute',
              top: 'var(--band-height-compact)',
              left: 0,
              right: 0,
              bottom: 0,
              background: 'var(--bg-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 50,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-sans)',
              cursor: 'default',
              padding: 'var(--space-12)',
              boxSizing: 'border-box',
              overflowY: 'auto'
            }}
            onClick={() => this.setState({isCustomModalOpen: false})}
          >
            <div
              style={{
                width: '100%',
                maxWidth: '460px',
                background: 'var(--bg-secondary)',
                border: '0.5px solid var(--border-focus)',
                borderRadius: '6px',
                padding: '20px',
                boxShadow: '0 8px 30px rgba(0, 0, 0, 0.5)',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header — Back returns to the picker buttons + URL bar */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                <button
                  type="button"
                  onClick={() => this.setState({isCustomModalOpen: false})}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 'var(--space-4)',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    padding: 0
                  }}
                >
                  <i className="ti ti-arrow-left" style={{fontSize: '14px'}} aria-hidden="true" />
                  Back
                </button>
                <span style={{fontSize: '14px', fontWeight: 600}}>
                  {this.state.customKind === 'agent' ? 'Create Custom Agent' : 'Create Custom Shell'}
                </span>
                <span style={{width: '44px'}} />
              </div>

              {/* Profile Name */}
              <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
                <label
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    color: 'var(--text-secondary)'
                  }}
                >
                  Profile Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. My Shell"
                  value={this.state.profileName}
                  onChange={(e) => this.setState({profileName: e.target.value})}
                  style={{
                    background: 'var(--bg-primary)',
                    border: '0.5px solid var(--border-neutral)',
                    color: 'var(--text-primary)',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    fontSize: '12px'
                  }}
                />
              </div>

              {/* Shell Executable Path — pick from detected shells, or type/browse a custom one */}
              <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
                <label
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    color: 'var(--text-secondary)'
                  }}
                >
                  Shell Path
                </label>
                <select
                  value={this.state.shellPath}
                  onChange={(e) => this.setState({shellPath: e.target.value})}
                  style={{
                    background: 'var(--bg-primary)',
                    border: '0.5px solid var(--border-neutral)',
                    color: 'var(--text-primary)',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    fontSize: '12px'
                  }}
                >
                  <option value="">Pick an existing shell… (or enter a path below)</option>
                  {(() => {
                    const seen = new Set<string>();
                    return ((this.props as any).profiles || [])
                      .filter((p: any) => p?.config?.shell && !seen.has(p.config.shell) && seen.add(p.config.shell))
                      .map((p: any) => (
                        <option key={p.name} value={p.config.shell}>
                          {`${p.name} — ${p.config.shell}`}
                        </option>
                      ));
                  })()}
                </select>
                <div style={{display: 'flex', gap: '6px'}}>
                  <input
                    type="text"
                    placeholder="e.g. /bin/bash or C:\Windows\System32\cmd.exe"
                    value={this.state.shellPath}
                    onChange={(e) => this.setState({shellPath: e.target.value})}
                    style={{
                      flex: 1,
                      background: 'var(--bg-primary)',
                      border: '0.5px solid var(--border-neutral)',
                      color: 'var(--text-primary)',
                      borderRadius: '4px',
                      padding: '8px 10px',
                      fontSize: '12px',
                      fontFamily: 'var(--font-mono)'
                    }}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const res = await ipcRenderer.invoke('pick-shell-executable');
                        if (res) this.setState({shellPath: res});
                      } catch (err) {
                        console.error(err);
                      }
                    }}
                    style={{
                      background: 'var(--bg-tertiary)',
                      border: '0.5px solid var(--border-neutral)',
                      color: 'var(--text-primary)',
                      borderRadius: '4px',
                      padding: '0 10px',
                      fontSize: '12px',
                      cursor: 'pointer'
                    }}
                  >
                    Browse…
                  </button>
                </div>
              </div>

              {/* Shell Arguments */}
              <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
                <label
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    color: 'var(--text-secondary)'
                  }}
                >
                  Arguments (comma separated)
                </label>
                <input
                  type="text"
                  placeholder="e.g. --login, -i"
                  value={this.state.shellArgs}
                  onChange={(e) => this.setState({shellArgs: e.target.value})}
                  style={{
                    background: 'var(--bg-primary)',
                    border: '0.5px solid var(--border-neutral)',
                    color: 'var(--text-primary)',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    fontSize: '12px',
                    fontFamily: 'var(--font-mono)'
                  }}
                />
              </div>

              {/* Environment Variables */}
              <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
                <label
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    color: 'var(--text-secondary)'
                  }}
                >
                  Environment Variables
                </label>
                <div
                  style={{
                    background: 'var(--bg-primary)',
                    border: '0.5px solid var(--border-neutral)',
                    borderRadius: '6px',
                    padding: '10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px'
                  }}
                >
                  {/* Env list */}
                  <div
                    style={{
                      maxHeight: '80px',
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px'
                    }}
                  >
                    {this.state.envVars.length === 0 ? (
                      <span
                        style={{
                          fontSize: '10px',
                          color: 'var(--text-tertiary)',
                          fontStyle: 'italic'
                        }}
                      >
                        No environment variables added.
                      </span>
                    ) : (
                      this.state.envVars.map((v, i) => (
                        <div
                          key={i}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            background: 'var(--bg-secondary)',
                            borderRadius: '4px',
                            padding: '3px 8px',
                            fontSize: '11px',
                            fontFamily: 'var(--font-mono)'
                          }}
                        >
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            <span style={{color: 'var(--info-text)'}}>{v.key}</span>={v.val}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              this.setState({
                                envVars: this.state.envVars.filter((_, idx) => idx !== i)
                              })
                            }
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--danger-text)',
                              cursor: 'pointer',
                              fontSize: '14px'
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Add inline form */}
                  <div style={{display: 'flex', gap: '6px'}}>
                    <input
                      type="text"
                      placeholder="KEY"
                      value={this.state.newEnvKey}
                      onChange={(e) =>
                        this.setState({
                          newEnvKey: e.target.value.replace(/[^a-zA-Z0-9_]/g, '')
                        })
                      }
                      style={{
                        flex: 1,
                        background: 'var(--bg-secondary)',
                        border: '0.5px solid var(--border-neutral)',
                        color: 'var(--text-primary)',
                        borderRadius: '4px',
                        padding: '6px 8px',
                        fontSize: '10px',
                        fontFamily: 'var(--font-mono)'
                      }}
                    />
                    <input
                      type="text"
                      placeholder="VALUE"
                      value={this.state.newEnvVal}
                      onChange={(e) => this.setState({newEnvVal: e.target.value})}
                      style={{
                        flex: 1.5,
                        background: 'var(--bg-secondary)',
                        border: '0.5px solid var(--border-neutral)',
                        color: 'var(--text-primary)',
                        borderRadius: '4px',
                        padding: '6px 8px',
                        fontSize: '10px',
                        fontFamily: 'var(--font-mono)'
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const k = this.state.newEnvKey.trim();
                        const v = this.state.newEnvVal.trim();
                        if (k) {
                          this.setState({
                            envVars: [...this.state.envVars.filter((item) => item.key !== k), {key: k, val: v}],
                            newEnvKey: '',
                            newEnvVal: ''
                          });
                        }
                      }}
                      style={{
                        background: 'var(--info-text)',
                        color: 'var(--bg-primary)',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '0 10px',
                        fontSize: '10px',
                        cursor: 'pointer'
                      }}
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '10px',
                  marginTop: '10px'
                }}
              >
                <button
                  type="button"
                  onClick={() => this.setState({isCustomModalOpen: false})}
                  style={{
                    background: 'var(--bg-primary)',
                    border: '0.5px solid var(--border-neutral)',
                    color: 'var(--text-secondary)',
                    borderRadius: '4px',
                    padding: '8px 14px',
                    fontSize: '12px',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!this.state.profileName.trim() || !this.state.shellPath.trim()}
                  onClick={this.saveCustomProfile}
                  style={{
                    background:
                      this.state.profileName.trim() && this.state.shellPath.trim()
                        ? 'var(--info-text)'
                        : 'var(--border-neutral)',
                    color: 'var(--bg-primary)',
                    border: 'none',
                    borderRadius: '4px',
                    padding: '8px 14px',
                    fontSize: '12px',
                    cursor: this.state.profileName.trim() && this.state.shellPath.trim() ? 'pointer' : 'default',
                    opacity: this.state.profileName.trim() && this.state.shellPath.trim() ? 1 : 0.6
                  }}
                >
                  Save Profile
                </button>
              </div>
            </div>
          </div>
        )}

        {this.props.customChildren}
        {this.props.search ? (
          <FindBar
            value={this.state.findText}
            active={findActive}
            total={findTotal}
            placeholder="Find"
            // Sit below the pane band (compact = 34px) like the web pane, instead
            // of overlapping it. No band shown → default 8px from the top.
            top={showLabelStrip ? '42px' : '8px'}
            inputRef={this.findInputRef}
            onChange={(v) => {
              this.setState({findText: v});
              this.searchNext(v);
            }}
            onNext={() => this.searchNext(this.state.findText)}
            onPrev={() => this.searchPrevious(this.state.findText)}
            onClose={this.closeSearchBox}
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
            background: var(--bg-primary);
            padding: var(--space-10) var(--space-16);
            box-sizing: border-box;
            overflow-y: auto;
            min-height: 0;
          }

          .term_pickerGrid {
            display: grid;
            /* Auto-fill up to 4 across when wide (max-width ~560 fits 4×110+gaps),
               and squish down to fewer columns as the pane narrows instead of
               forcing a fixed column count. */
            grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
            gap: 6px;
            width: 100%;
            max-width: 560px;
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
            gap: 6px;
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

          @keyframes pickerGlimmer {
            0% {
              border-color: var(--border-neutral);
              box-shadow: none;
            }
            30% {
              border-color: var(--border-focus);
              box-shadow: 0 0 10px rgba(0, 149, 255, 0.4);
            }
            100% {
              border-color: var(--border-neutral);
              box-shadow: none;
            }
          }

          .term_glimmer {
            animation: pickerGlimmer 0.6s ease-in-out;
          }

          .term_pickerGrid_rev {
            display: grid;
            /* 4 across when wide (560 fits 4×110+gaps), squish to fewer as the
               pane narrows. auto-fit + margin auto keeps the grid centered. */
            grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
            gap: 6px;
            width: 100%;
            max-width: 560px;
            margin: 0 auto;
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
            gap: 6px;
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

          .term_fit {
            position: relative;
            container-type: inline-size;
            container-name: pane;
          }

          .term_labelFull {
            display: inline;
          }

          .term_labelShort {
            display: none;
          }

          @container pane (max-width: 380px) {
            .term_labelFull {
              display: none !important;
            }
            .term_labelShort {
              display: inline !important;
            }
            .term_profileChip {
              display: none !important;
            }
            /* The dir bar no longer collapses to an icon-only stub here — it's
               kept floored (border + ~11 chars) by inline styles down to ~320px
               and hidden entirely below that (showDirBar), matching the web
               pane's URL bar. */
          }
        `}</style>
      </div>
    );
  }
}
