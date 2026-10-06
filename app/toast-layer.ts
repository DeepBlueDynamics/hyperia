// ToastLayer — transparent WebContentsViews per BrowserWindow, one per anchor:
// 'top' hosts the agent create-consent cards and "waiting" pills; 'bottom-right'
// hosts the stacking notices (drag-drop copy results, audio, update, messages).
//
// Why a native view: a web pane's WebContentsView paints above the whole
// renderer DOM, so a DOM toast sits BEHIND any web pane it overlaps (#297). The
// old answer was to freeze-swap the web pane (screenshot, hide the native view,
// show the still) for as long as the toast was up — a visible repaint on every
// toast and a dead page underneath. A sibling view that is (a) transparent and
// (b) always re-added LAST in the window's view tree composites above every
// web pane with the page still live below it.
//
// The renderer stays the source of truth: it sends the toast list + a theme
// snapshot over `toast-layer:render`; the layer page (app/toast-layer.html)
// renders it, reports its content size, and echoes button clicks back as
// `toast-layer:action`, which we relay to the host renderer.
//
// focus-never-steal: nothing here ever focuses the layer. A click on it does,
// natively — so after any click we hand focus straight back to the host.

import {resolve} from 'path';

import {BrowserWindow, WebContentsView, app, ipcMain} from 'electron';

import isDev from 'electron-is-dev';

import {bottomRightBounds, topCenterBounds} from './utils/toast-layer-bounds';

export type ToastLayerAnchor = 'top' | 'bottom-right';

export interface ToastLayerButton {
  id: string;
  label: string;
  style?: 'plain' | 'allow' | 'deny';
}

export interface ToastLayerItem {
  id: string;
  // 'toast' = a bottom-right notice: icon + text + optional buttons + close.
  kind: 'card' | 'pill' | 'toast';
  emoji?: string;
  who?: string;
  text: string;
  title?: string;
  buttons?: ToastLayerButton[];
  tone?: 'info' | 'error';
  // Show a × that sends the 'close' action.
  dismissable?: boolean;
}

export interface ToastLayerPayload {
  items: ToastLayerItem[];
  theme?: Record<string, string>;
  zoom?: number;
  anchor?: ToastLayerAnchor;
}

interface LayerEntry {
  key: string;
  anchor: ToastLayerAnchor;
  view: WebContentsView;
  win: BrowserWindow;
  loaded: boolean;
  // Latest payload — replayed once the page finishes loading.
  pending: ToastLayerPayload | null;
  // Last content size the page reported (its CSS px) and the zoom it was measured at.
  cssW: number;
  cssH: number;
  zoom: number;
  hasItems: boolean;
  onResize: () => void;
}

// Keyed by `${win.id}:${anchor}`.
const layers = new Map<string, LayerEntry>();
const layerKey = (win: BrowserWindow, anchor: ToastLayerAnchor) => `${win.id}:${anchor}`;
export const normalizeToastLayerAnchor = (a: unknown): ToastLayerAnchor =>
  a === 'bottom-right' ? 'bottom-right' : 'top';
// Set once creating a layer throws (e.g. an Electron build where transparent
// child views don't exist) — the renderer then keeps its DOM toasts.
let broken = false;

// Delay before handing focus back to the host after the layer was clicked —
// long enough for a click's mousedown/mouseup pair to land on the same view.
const REFOCUS_MS = 120;

export function resolveToastLayerHtmlPath(isDevMode: boolean = isDev, appPath?: string): string {
  const baseDir = isDevMode ? __dirname : appPath || (app ? app.getAppPath() : __dirname);
  return resolve(baseDir, 'toast-layer.html');
}

function position(entry: LayerEntry): void {
  if (entry.win.isDestroyed()) return;
  const {width, height} = entry.win.getContentBounds();
  entry.view.setBounds(
    entry.anchor === 'bottom-right'
      ? bottomRightBounds(width, height, entry.cssW, entry.cssH, entry.zoom)
      : topCenterBounds(width, entry.cssW, entry.cssH, entry.zoom)
  );
  reportBounds(entry);
}

function applyVisible(entry: LayerEntry): void {
  const show = entry.hasItems && entry.loaded && entry.cssW > 0 && entry.cssH > 0;
  entry.view.setVisible(show);
  reportBounds(entry);
}

// The top layer covers the window's top drag strip. Windows hit-tests the
// HOST's drag region before the click reaches this view, so a pill there
// started a window drag instead of clicking. Tell the host where the visible
// layer is so it can carve a no-drag hole of the same size.
function reportBounds(entry: LayerEntry): void {
  if (entry.anchor !== 'top') return;
  if (entry.win.isDestroyed() || entry.win.webContents.isDestroyed()) return;
  const visible = entry.hasItems && entry.loaded && entry.cssW > 0 && entry.cssH > 0;
  entry.win.webContents.send('toast-layer:bounds', visible ? entry.view.getBounds() : null);
}

function pushRender(entry: LayerEntry, payload: ToastLayerPayload): void {
  entry.pending = payload;
  entry.hasItems = payload.items.length > 0;
  if (typeof payload.zoom === 'number' && payload.zoom > 0 && payload.zoom !== entry.zoom) {
    entry.zoom = payload.zoom;
    try {
      entry.view.webContents.setZoomFactor(entry.zoom);
    } catch {
      /* not fatal — bounds still scale by entry.zoom */
    }
    position(entry);
  }
  if (!entry.hasItems) applyVisible(entry);
  if (!entry.loaded || entry.view.webContents.isDestroyed()) return;
  entry.view.webContents.send('toast-layer:render', payload);
}

function dropLayer(key: string): void {
  const entry = layers.get(key);
  if (!entry) return;
  layers.delete(key);
  try {
    if (!entry.win.isDestroyed()) {
      entry.win.off('resize', entry.onResize);
      entry.win.contentView.removeChildView(entry.view);
    }
  } catch {
    /* window may be tearing down */
  }
  try {
    // WebContentsView webContents are NOT auto-destroyed (same as web panes).
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  } catch {
    /* ignore */
  }
}

function ensureLayer(win: BrowserWindow, anchor: ToastLayerAnchor): LayerEntry | null {
  const key = layerKey(win, anchor);
  const existing = layers.get(key);
  if (existing) return existing;
  if (broken || win.isDestroyed()) return null;
  try {
    const view = new WebContentsView({
      webPreferences: {
        preload: resolve(__dirname, 'toast-layer', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        transparent: true
      }
    });
    view.setBackgroundColor('#00000000');
    const entry: LayerEntry = {
      key,
      anchor,
      view,
      win,
      loaded: false,
      pending: null,
      cssW: 0,
      cssH: 0,
      zoom: win.webContents.getZoomFactor() || 1,
      hasItems: false,
      onResize: () => position(entry)
    };
    layers.set(key, entry);
    view.setVisible(false);
    view.setBounds({x: 0, y: 0, width: 1, height: 1});
    win.contentView.addChildView(view);
    const wc = view.webContents;
    // The page is ours and static — nothing it does may navigate or open windows.
    wc.setWindowOpenHandler(() => ({action: 'deny'}));
    wc.on('will-navigate', (e) => e.preventDefault());
    // The page has no devtools of its own — surface its errors in main's log.
    wc.on('console-message', (_e, level, message, line) => {
      if (level >= 2)
        console.warn(`[toast-layer] page ${level === 3 ? 'error' : 'warning'}: ${message} (line ${line})`);
    });
    wc.on('did-finish-load', () => {
      if (layers.get(key) !== entry) return;
      entry.loaded = true;
      try {
        wc.setZoomFactor(entry.zoom);
      } catch {
        /* ignore */
      }
      if (entry.pending) wc.send('toast-layer:render', entry.pending);
    });
    // A click on the layer focuses it natively; give focus back to the host so
    // the terminal keeps the keyboard (focus-never-steal).
    wc.on('focus', () => {
      setTimeout(() => {
        if (!win.isDestroyed() && layers.get(key) === entry) win.webContents.focus();
      }, REFOCUS_MS);
    });
    wc.on('render-process-gone', () => {
      // Rebuilt lazily on the next render; the renderer's DOM fallback is not
      // needed for a one-off crash.
      dropLayer(key);
    });
    win.on('resize', entry.onResize);
    win.once('closed', () => dropLayer(key));
    void wc.loadFile(resolveToastLayerHtmlPath()).catch((err) => {
      console.warn('[toast-layer] load failed:', err);
      dropLayer(key);
    });
    return entry;
  } catch (err) {
    console.warn('[toast-layer] unavailable, keeping DOM toasts:', err);
    broken = true;
    dropLayer(key);
    return null;
  }
}

/**
 * Keep the layers above every other child view. Call after ANY other
 * WebContentsView (web pane, docked devtools) is added to the window —
 * re-adding an attached view moves it to the top of the stack.
 */
export function raiseToastLayer(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  for (const entry of layers.values()) {
    if (entry.win !== win) continue;
    try {
      win.contentView.addChildView(entry.view);
    } catch {
      /* ignore */
    }
  }
}

export function destroyToastLayerForWindow(win: BrowserWindow): void {
  for (const entry of Array.from(layers.values())) {
    if (entry.win === win) dropLayer(entry.key);
  }
}

/** True when the layer can be used (never tried, or tried and worked). */
export function toastLayerAvailable(): boolean {
  return !broken;
}

let inited = false;

/** Register the IPC surface. Idempotent. */
export function initToastLayer(): void {
  if (inited) return;
  inited = true;

  const winOf = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);
  const entryOfLayer = (e: Electron.IpcMainEvent): LayerEntry | undefined => {
    for (const entry of layers.values()) {
      if (entry.view.webContents === e.sender) return entry;
    }
    return undefined;
  };

  ipcMain.handle('toast-layer:available', () => toastLayerAvailable());

  // Host renderer → layer: the full list for one anchor (empty = hide).
  ipcMain.on('toast-layer:render', (e, payload: ToastLayerPayload) => {
    const win = winOf(e);
    if (!win || win.isDestroyed()) return;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const anchor = normalizeToastLayerAnchor(payload?.anchor);
    // Don't build a view just to tell it there's nothing to show.
    if (items.length === 0 && !layers.has(layerKey(win, anchor))) return;
    const entry = ensureLayer(win, anchor);
    if (!entry) return;
    pushRender(entry, {items, theme: payload?.theme, zoom: payload?.zoom, anchor});
  });

  // Layer → main: its rendered content size, in the layer's CSS px.
  ipcMain.on('toast-layer:size', (e, size: {width: number; height: number}) => {
    const entry = entryOfLayer(e);
    if (!entry) return;
    entry.cssW = Math.max(0, Number(size?.width) || 0);
    entry.cssH = Math.max(0, Number(size?.height) || 0);
    position(entry);
    applyVisible(entry);
  });

  // Layer → host renderer: a button (or pill) was clicked.
  ipcMain.on('toast-layer:action', (e, action: {toastId: string; buttonId: string}) => {
    const entry = entryOfLayer(e);
    if (!entry || entry.win.isDestroyed()) return;
    entry.win.webContents.send('toast-layer:action', {
      toastId: String(action?.toastId ?? ''),
      buttonId: String(action?.buttonId ?? '')
    });
    entry.win.webContents.focus();
  });
}
