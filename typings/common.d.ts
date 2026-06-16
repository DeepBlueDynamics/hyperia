import type {ExecFileOptions, ExecOptions} from 'child_process';

import type {IpcMain, IpcRenderer} from 'electron';

import type parseUrl from 'parse-url';

import type {configOptions} from './config';

export type Session = {
  uid: string;
  rows?: number | null;
  cols?: number | null;
  splitDirection?: 'HORIZONTAL' | 'VERTICAL';
  shell: string | null;
  pid: number | null;
  activeUid?: string;
  profile: string;
  groupUid?: string;
  url?: string;
  cwd?: string;
  isNewGroup?: boolean;
  isRestore?: boolean;
  lastCommand?: string;
};

export type sessionExtraOptions = {
  uid?: string;
  isRestore?: boolean;
  lastCommand?: string;
  cwd?: string;
  splitDirection?: 'HORIZONTAL' | 'VERTICAL';
  activeUid?: string | null;
  isNewGroup?: boolean;
  rows?: number;
  cols?: number;
  shell?: string;
  shellArgs?: string[];
  profile?: string;
  groupUid?: string;
  url?: string;
};

export type MainEvents = {
  close: never;
  command: string;
  data: {uid: string | null; data: string; escaped?: boolean};
  exit: {uid: string};
  'info renderer': {uid: string; type: string};
  init: null;
  maximize: never;
  minimize: never;
  new: sessionExtraOptions;
  'open context menu': string;
  'open external': {url: string};
  'open hamburger menu': {x: number; y: number};
  'quit and install': never;
  resize: {uid: string; cols: number; rows: number};
  'session set xterm title': {uid: string; title: string; manual?: boolean};
  'session set active': {uid: string};
  'session set description': {uid: string; description: string};
  'session set tab name': {uid: string; tabName: string};
  'session layout sync': Array<{
    rootGroupUid: string;
    order: number;
    active: boolean;
    panes: Array<{
      uid: string;
      splitLabel: string;
      isWeb: boolean;
      isAi: boolean;
      title: string;
      shellName: string;
      url?: string;
      active: boolean;
    }>;
  }>;
  'permission request': {id: string; requester: string; requesterPane: string; targetPane: string};
  'permission resolved': {targetPane: string; decision: string; id?: string};
  'agent toast': {id: string; requester: string; action: string};
  unmaximize: never;
  'web-pane-reload': string;
  'web-pane-click-result': {uid: string; result: any};
  'web-pane-read-result': {uid: string; result: any};
  'web-pane-eval-result': {uid: string; result: any};
  'web-pane-mouse-result': {uid: string; result: any};
  'split request vertical': {activeUid?: string | null; profile?: string | null; url?: string};
  'split request horizontal': {activeUid?: string | null; profile?: string | null; url?: string};
  'split web pane req': {activeUid?: string | null; url?: string; direction?: 'HORIZONTAL' | 'VERTICAL'};
  'clone request vertical': any;
  'clone request horizontal': any;
  'layout-state-reply': any;
  'web-pane-zoom-in': {uid: string};
  'web-pane-zoom-out': {uid: string};
  'web-pane-zoom-reset': {uid: string};
  'picker-zoom-in': {uid: string};
  'picker-zoom-out': {uid: string};
  'picker-zoom-reset': {uid: string};
  'session-cd': {uid: string; path: string};
};

export type RendererEvents = {
  'session-cd-reply': {uid: string; applied?: boolean; queued?: boolean; refused?: boolean; reason?: string};
  ready: never;
  'session rename': {uid: string; name: string};
  'session set active': {uid: string};
  'web-pane-click': {uid: string; text?: string; selector?: string};
  'web-pane-read': {uid: string};
  'web-pane-eval': {uid: string; js: string};
  'web-pane-mouse': {uid: string; x: number; y: number; action?: string};
  'add notification': {text: string; url: string; dismissable: boolean};
  'update available': {releaseNotes: string; releaseName: string; releaseUrl: string; canInstall: boolean};
  'open ssh': ReturnType<typeof parseUrl>;
  'open file': {path: string};
  'move jump req': number | 'last';
  'reset fontSize req': never;
  'move left req': never;
  'move right req': never;
  'prev pane req': never;
  'decrease fontSize req': never;
  'increase fontSize req': never;
  'next pane req': never;
  'session break req': never;
  'session quit req': never;
  'session search close': never;
  'session search': never;
  'session stop req': never;
  'session tmux req': never;
  'session del line beginning req': never;
  'session del line end req': never;
  'session del word left req': never;
  'session del word right req': never;
  'session move line beginning req': never;
  'session move line end req': never;
  'session move word left req': never;
  'session move word right req': never;
  'term selectAll': never;
  reload: never;
  'session clear req': never;
  'split request horizontal': {activeUid?: string | null; profile?: string | null; url?: string};
  'split web pane req': {activeUid?: string | null; url?: string; direction?: 'HORIZONTAL' | 'VERTICAL'};
  'split request vertical': {activeUid?: string | null; profile?: string | null; url?: string};
  'clone request vertical': any;
  'clone request horizontal': any;
  'termgroup add req': {activeUid?: string | null; profile?: string | null};
  'termgroup close req': never;
  'web-pane-reload': string;
  'session add': Session;
  'session data': string;
  'session cwd': {uid: string; cwd: string};
  'session exit': {uid: string};
  'permission request': {id: string; requester: string; requesterPane: string; targetPane: string};
  'permission resolved': {targetPane: string; decision: string; id?: string};
  'agent toast': {id: string; requester: string; action: string};
  'windowGeometry change': {isMaximized: boolean};
  move: {bounds: {x: number; y: number}};
  'enter full screen': never;
  'leave full screen': never;
  'session data send': {uid: string | null; data: string; escaped?: boolean};
  'agent status': {sessionUid?: string; connected: boolean; working?: boolean; label?: string; humanPercent?: number};
  'open web pane req': {url?: string};
  'get-layout-state-req': never;
  'restore-layout-state': any;
  'web-pane-zoom-in': {uid: string};
  'web-pane-zoom-out': {uid: string};
  'web-pane-zoom-reset': {uid: string};
  'picker-zoom-in': {uid: string};
  'picker-zoom-out': {uid: string};
  'picker-zoom-reset': {uid: string};
};

/**
 * Get keys of T where the value is not never
 */
export type FilterNever<T> = {[K in keyof T]: T[K] extends never ? never : K}[keyof T];

export interface TypedEmitter<Events> {
  on<E extends keyof Events>(event: E, listener: (args: Events[E]) => void): this;
  once<E extends keyof Events>(event: E, listener: (args: Events[E]) => void): this;
  emit<E extends Exclude<keyof Events, FilterNever<Events>>>(event: E): boolean;
  emit<E extends FilterNever<Events>>(event: E, data: Events[E]): boolean;
  emit<E extends keyof Events>(event: E, data?: Events[E]): boolean;
  removeListener<E extends keyof Events>(event: E, listener: (args: Events[E]) => void): this;
  removeAllListeners<E extends keyof Events>(event?: E): this;
}

type OptionalPromise<T> = T | Promise<T>;

export type IpcCommands = {
  'child_process.exec': (command: string, options: ExecOptions) => {stdout: string; stderr: string};
  'child_process.execFile': (
    file: string,
    args: string[],
    options: ExecFileOptions
  ) => {
    stdout: string;
    stderr: string;
  };
  getLoadedPluginVersions: () => {name: string; version: string}[];
  getPaths: () => {plugins: string[]; localPlugins: string[]};
  getBasePaths: () => {path: string; localPath: string};
  getDeprecatedConfig: () => Record<string, {css: string[]}>;
  getDecoratedConfig: (profile: string) => configOptions;
  getDecoratedKeymaps: () => Record<string, string[]>;
  'pick-shell-executable': () => string | null;
};

export interface IpcMainWithCommands extends IpcMain {
  handle<E extends keyof IpcCommands>(
    channel: E,
    listener: (
      event: Electron.IpcMainInvokeEvent,
      ...args: Parameters<IpcCommands[E]>
    ) => OptionalPromise<ReturnType<IpcCommands[E]>>
  ): void;
}

export interface IpcRendererWithCommands extends IpcRenderer {
  invoke<E extends keyof IpcCommands>(
    channel: E,
    ...args: Parameters<IpcCommands[E]>
  ): Promise<ReturnType<IpcCommands[E]>>;
}
