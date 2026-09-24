/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable @typescript-eslint/no-var-requires */

import {mkdirSync, mkdtempSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import type {ExecutionContext} from 'ava';

import type {StickyFixture, StickyTestApi} from './sticky-main-types';

export type {StickyFixture, StickyTestApi, StickyTestCreateNoteResult} from './sticky-main-types';

const proxyquire = require('proxyquire').noCallThru().noPreserveCache();

const baseTmpDir = process.env.TMPDIR || tmpdir() || join(process.cwd(), '.hyperia-test-temp');
mkdirSync(baseTmpDir, {recursive: true});

export class FakeWebContents {
  sent: Array<{channel: string; args: any[]}> = [];
  focused = false;
  focusCalls = 0;
  listeners: Record<string, Function[]> = {};
  mainFrame = {parent: null};
  windowOpenHandler: Function | null = null;

  isDestroyed() {
    return false;
  }

  send(channel: string, ...args: any[]) {
    this.sent.push({channel, args});
  }

  on(event: string, fn: Function) {
    (this.listeners[event] = this.listeners[event] || []).push(fn);
    return this;
  }

  setWindowOpenHandler(fn: Function) {
    this.windowOpenHandler = fn;
  }

  focus() {
    this.focusCalls++;
    this.focused = true;
  }

  blur() {
    this.focused = false;
  }
}

export class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = [];
  listeners: Record<string, Function[]> = {};
  visible = false;
  destroyed = false;
  alwaysOnTop = false;
  focused = false;
  focusCalls = 0;
  opacity = 1.0;
  bounds = {x: 100, y: 100, width: 300, height: 200};
  webContents = new FakeWebContents();
  __startedHidden?: boolean;
  backgroundColor = '#fff';
  loadedFile: string | null = null;

  constructor(public opts: any = {}) {
    FakeBrowserWindow.instances.push(this);
    this.visible = !!opts.show;
    this.backgroundColor = opts.backgroundColor;
  }

  static fromWebContents(wc: any) {
    return FakeBrowserWindow.instances.find((w) => w.webContents === wc) || null;
  }

  static getAllWindows() {
    return FakeBrowserWindow.instances.filter((w) => !w.destroyed);
  }

  on(event: string, fn: Function) {
    (this.listeners[event] = this.listeners[event] || []).push(fn);
    return this;
  }

  once(event: string, fn: Function) {
    const wrapper = (...args: any[]) => {
      this.removeListener(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  removeListener(event: string, fn: Function) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    }
  }

  emit(event: string, ...args: any[]) {
    const fns = [...(this.listeners[event] || [])];
    for (const f of fns) f(...args);
  }

  show() {
    this.visible = true;
    this.focused = true;
    this.webContents.focused = true;
    this.emit('show');
    this.emit('focus');
  }

  showInactive() {
    this.visible = true;
    this.emit('show');
  }

  hide() {
    this.visible = false;
    this.focused = false;
    this.webContents.focused = false;
    this.emit('hide');
    this.emit('blur');
  }

  close() {
    this.destroyed = true;
    this.visible = false;
    this.focused = false;
    this.webContents.focused = false;
    this.emit('closed');
    this.emit('blur');
  }

  focus() {
    this.focusCalls++;
    this.focused = true;
    this.webContents.focused = true;
    this.emit('focus');
  }

  blur() {
    this.focused = false;
    this.webContents.focused = false;
    this.emit('blur');
  }

  isDestroyed() {
    return this.destroyed;
  }

  isVisible() {
    return this.visible && !this.destroyed;
  }

  isFocused() {
    return this.focused && !this.destroyed;
  }

  getBounds() {
    return {...this.bounds};
  }

  setBounds(b: Partial<{x: number; y: number; width: number; height: number}>) {
    this.bounds = {...this.bounds, ...b};
  }

  setAlwaysOnTop(on: boolean) {
    this.alwaysOnTop = on;
  }

  setOpacity(op: number) {
    this.opacity = op;
  }

  moveTop() {}

  loadFile(filePath: string) {
    this.loadedFile = filePath;
    return Promise.resolve();
  }

  setBackgroundColor(c: string) {
    this.backgroundColor = c;
  }

  setVisibleOnAllWorkspaces() {}
}

export class FakeNotification {
  static instances: FakeNotification[] = [];
  listeners: Record<string, Function[]> = {};
  title: string;
  body: string;

  constructor(public opts: {title: string; body: string}) {
    this.title = opts.title;
    this.body = opts.body;
    FakeNotification.instances.push(this);
  }

  static isSupported() {
    return true;
  }

  on(event: string, fn: Function) {
    (this.listeners[event] = this.listeners[event] || []).push(fn);
    return this;
  }

  emit(event: string, ...args: any[]) {
    const fns = [...(this.listeners[event] || [])];
    for (const f of fns) f(...args);
  }

  show() {}
}

export function createStickyFixture(t: ExecutionContext, options: {autoInit?: boolean} = {}): StickyFixture {
  FakeBrowserWindow.instances = [];
  FakeNotification.instances = [];

  const initialCacheKeys = new Set(Object.keys(require.cache));

  const testDir = mkdtempSync(join(baseTmpDir, 'sticky-fixture-'));
  const stickysDir = join(testDir, '.hyperia', 'stickys');
  mkdirSync(stickysDir, {recursive: true});

  const notesFile = join(stickysDir, 'notes.json');
  const stateFile = join(stickysDir, 'state.json');
  const defaultsFile = join(stickysDir, 'defaults.json');

  // Capture global timers
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const originalRandom = Math.random;

  const capturedTimeouts: Array<{fn: Function; ms: number}> = [];
  const capturedIntervals: Array<{fn: Function; ms: number}> = [];

  (global as any).setTimeout = (fn: Function, ms: number) => {
    capturedTimeouts.push({fn, ms});
    return capturedTimeouts.length as any;
  };

  (global as any).setInterval = (fn: Function, ms: number) => {
    capturedIntervals.push({fn, ms});
    return capturedIntervals.length as any;
  };

  const teardown = () => {
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    Math.random = originalRandom;
    for (const key of Object.keys(require.cache)) {
      if (!initialCacheKeys.has(key)) {
        delete require.cache[key];
      }
    }
  };
  t.teardown(teardown);

  // Capture IPC
  const ipcListeners = new Map<string, Function[]>();
  const ipcHandlers = new Map<string, Function>();

  const ipcMain = {
    on: (channel: string, listener: Function) => {
      const list = ipcListeners.get(channel) || [];
      list.push(listener);
      ipcListeners.set(channel, list);
    },
    handle: (channel: string, handler: Function) => {
      ipcHandlers.set(channel, handler);
    },
    emit: (channel: string, ...args: any[]) => {
      const list = ipcListeners.get(channel) || [];
      for (const fn of list) {
        fn({sender: {}}, ...args);
      }
      return list.length > 0;
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel);
    }
  };

  const fakeElectron = {
    app: {
      getAppPath: () => join(__dirname, '../../app')
    },
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getCursorScreenPoint: () => ({x: 500, y: 500}),
      getDisplayNearestPoint: () => ({
        workArea: {x: 0, y: 0, width: 1920, height: 1080}
      })
    },
    nativeImage: {
      createFromBuffer: () => ({})
    },
    Notification: FakeNotification,
    dialog: {
      showOpenDialog: () => Promise.resolve({canceled: true, filePaths: []})
    },
    shell: {
      openPath: () => Promise.resolve(''),
      openExternal: () => Promise.resolve(true)
    },
    Menu: {
      buildFromTemplate: () => ({
        popup: () => {}
      })
    },
    ipcMain
  };

  const fakeOs = {
    homedir: () => testDir,
    platform: () => 'linux'
  };

  const stubs = {
    electron: {
      '@global': true,
      '@noCallThru': true,
      ...fakeElectron
    },
    os: {
      '@global': true,
      '@noCallThru': true,
      ...fakeOs
    },
    'electron-is-dev': {
      '@global': true,
      '@noCallThru': true,
      default: true
    }
  };

  // Load ONLY the public facade
  const sticky: StickyTestApi = proxyquire('../../app/sticky', stubs);

  if (options.autoInit !== false) {
    sticky.initSticky();
  }

  const triggerStartupRestore = () => {
    const item = capturedTimeouts.find((x) => x.ms === 400);
    if (item) item.fn();
  };

  const triggerSchedulerTick = async () => {
    const item = capturedIntervals.find((x) => x.ms === 15000);
    if (item) await item.fn();
  };

  return {
    testDir,
    stickysDir,
    notesFile,
    stateFile,
    defaultsFile,
    sticky,
    ipcEmit: (channel: string, ...args: any[]) => ipcMain.emit(channel, ...args),
    ipcInvoke: async (channel: string, event: any, ...args: any[]) => {
      const handler = ipcHandlers.get(channel);
      if (!handler) throw new Error(`No handler registered for ${channel}`);
      return await handler(event, ...args);
    },
    ipcHasHandler: (channel: string) => ipcHandlers.has(channel),
    triggerStartupRestore,
    triggerSchedulerTick,
    teardown,
    windows: FakeBrowserWindow.instances,
    notifications: FakeNotification.instances
  };
}
