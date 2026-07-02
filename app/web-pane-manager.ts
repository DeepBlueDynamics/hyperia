// WebPaneManager — owns the native WebContentsView instances that replace the
// legacy <webview> tag (see plan/webcontentsview-migration.md).
//
// Each Hyperia web pane maps to one WebContentsView attached to its BrowserWindow
// via win.contentView.addChildView(). The RENDERER stays the source of truth for
// geometry (it owns the flex/percentage split layout) and pushes each pane's
// pixel rect here; the main process positions the native view with setBounds().
// Page state (title/url/loading/canGo*) flows the other way, pushed to the
// renderer so the DOM chrome (PaneBand, URL bar) can render it.
//
// Electron gotcha baked in here: a WebContentsView's webContents is NOT destroyed
// automatically when its window closes or it's detached — we MUST close it in
// destroy()/destroyForWindow() or we leak renderer processes.

import {mkdirSync, writeFileSync} from 'fs';
import {homedir} from 'os';
import {join} from 'path';

import {BrowserWindow, WebContentsView, ipcMain, session, shell, Menu, clipboard} from 'electron';
import type {Session, WebContents} from 'electron';

const PARTITION = 'persist:hyperia-web';
// DevTools docks into the bottom of the pane, taking this fraction of its height.
const DEVTOOLS_FRACTION = 0.4;

// OAuth / login popups can't run inside an embedded browser — hand them to the
// system browser (parity with the old <webview> guest handler).
function isOAuthUrl(url: string): boolean {
  return /^https?:\/\/(accounts\.google\.|login\.microsoftonline\.|appleid\.apple\.|github\.com\/login|login\.yahoo\.|(www\.)?facebook\.com\/(login|dialog)|api\.twitter\.com\/oauth|([a-z0-9-]+\.)?nuts\.services\/(auth|login))/i.test(
    url
  );
}

// Applied once to the shared web-pane session (the Chrome-UA + sec-ch-ua rewrite
// that beats Cloudflare). Injected by window.ts so we reuse the exact same
// configureWebPaneSession without a circular import.
type ConfigureSession = (sess: Session) => void;

interface WebPaneEntry {
  view: WebContentsView;
  win: BrowserWindow;
  url: string;
  visible: boolean;
  // Pending delayed teardown (see destroyPane) — cancelled if the pane remounts.
  destroyTimer?: ReturnType<typeof setTimeout>;
  // Last pixel rect pushed from the renderer — used to re-split when the docked
  // inspector opens/closes without waiting for the next bounds tick.
  lastBounds?: {x: number; y: number; width: number; height: number};
  // Docked DevTools view (Inspect → split inside the pane).
  devtools?: WebContentsView;
}

// Keyed by pane uid (unique across windows).
const panes = new Map<string, WebPaneEntry>();
let configureSession: ConfigureSession | null = null;
let sharedSession: Session | null = null;

function getSharedSession(): Session {
  if (!sharedSession) {
    sharedSession = session.fromPartition(PARTITION);
    configureSession?.(sharedSession);
  }
  return sharedSession;
}

// Push page state to the pane's owning renderer. `partial` carries only the
// fields that changed.
function pushState(uid: string, partial: Record<string, unknown>) {
  const entry = panes.get(uid);
  if (!entry || entry.win.isDestroyed()) return;
  entry.win.webContents.send('web-pane:state', {uid, ...partial});
}

function navState(wc: WebContents) {
  return {url: wc.getURL(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward()};
}

function wireWebContents(uid: string, wc: WebContents) {
  wc.on('did-start-loading', () => pushState(uid, {loading: true, error: null}));
  wc.on('did-stop-loading', () => pushState(uid, {loading: false, ...navState(wc)}));
  wc.on('did-navigate', () => pushState(uid, {...navState(wc)}));
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
    if (isMainFrame) pushState(uid, {...navState(wc)});
  });
  wc.on('page-title-updated', (_e, title) => pushState(uid, {title}));
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED (user/redirect navigation), not a real failure.
    if (isMainFrame && errorCode !== -3) {
      pushState(uid, {loading: false, error: {code: errorCode, description: errorDescription, url: validatedURL}});
    }
  });
  wc.on('found-in-page', (_e, result) => {
    entrySend(uid, 'web-pane:found-in-page', {
      uid,
      active: result.activeMatchOrdinal,
      total: result.matches
    });
  });
  // Let the renderer run its dom-ready work (scrollbar CSS inject, bg-color probe)
  // via web-pane:execute-js — it can't observe the guest's dom-ready directly.
  wc.on('dom-ready', () => entrySend(uid, 'web-pane:dom-ready', {uid}));
  // Clicking into the page focuses its webContents — tell the renderer so it can
  // activate the pane (and dismiss the URL navigator).
  wc.on('focus', () => entrySend(uid, 'web-pane:focus', {uid}));
  // Zoom shortcuts pressed while the PAGE has focus never reach the renderer's
  // window (the native view captures them), so intercept Ctrl/Cmd +/-/0 here and
  // route to the renderer's zoom handlers (which own the zoom-factor state).
  wc.on('before-input-event', (event: Electron.Event, input: Electron.Input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const k = input.key;
    let dir: 'in' | 'out' | 'reset' | null = null;
    if (k === '+' || k === '=' || k === 'Add') dir = 'in';
    else if (k === '-' || k === '_' || k === 'Subtract') dir = 'out';
    else if (k === '0') dir = 'reset';
    if (dir) {
      event.preventDefault();
      entrySend(uid, 'web-pane:zoom-key', {uid, dir});
    }
  });
  // Right-click menu — rebuilt on the native webContents (the old <webview>
  // guest handler in window.ts no longer fires). Reload / screenshot / copy /
  // paste / back-forward / copy-link / find / inspect-in-split / stickys.
  wc.on('context-menu', (_e: Electron.Event, params: Electron.ContextMenuParams) => {
    const entry = panes.get(uid);
    if (!entry) return;
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.misspelledWord) {
      if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
        for (const s of params.dictionarySuggestions) {
          items.push({label: s, click: () => void wc.insertText(s)});
        }
      } else {
        items.push({label: 'No spelling suggestions', enabled: false});
      }
      items.push(
        {
          label: 'Add to Dictionary',
          click: () => {
            try {
              wc.session.addWordToSpellCheckerDictionary(params.misspelledWord);
            } catch {
              /* ignore */
            }
          }
        },
        {type: 'separator'}
      );
    }
    items.push(
      {label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack()},
      {label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward()},
      {label: 'Reload', click: () => wc.reload()},
      {type: 'separator'}
    );
    if (params.linkURL) {
      items.push(
        {label: 'Copy Link', click: () => clipboard.writeText(params.linkURL)},
        {label: 'Open Link in Browser', click: () => void shell.openExternal(params.linkURL)},
        {type: 'separator'}
      );
    }
    items.push(
      {label: 'Copy', enabled: !!params.editFlags?.canCopy, click: () => wc.copy()},
      {label: 'Paste', enabled: !!params.editFlags?.canPaste, click: () => wc.paste()},
      {label: 'Cut', enabled: !!params.editFlags?.canCut, click: () => wc.cut()},
      {label: 'Select All', click: () => wc.selectAll()},
      {type: 'separator'},
      {label: 'Find in page', accelerator: 'CmdOrCtrl+F', click: () => entrySend(uid, 'web-pane:find-open', {uid})},
      {label: 'Screenshot', click: () => void screenshotPane(uid)},
      {type: 'separator'},
      entry.devtools
        ? {label: 'Close Inspector', click: () => closeInspector(uid)}
        : {label: 'Inspect (split)', click: () => openInspector(uid, params.x, params.y)},
      {type: 'separator'},
      {label: 'New Stickys', click: () => void ipcMain.emit('new-sticky', {})},
      {label: 'Search Stickys', click: () => void ipcMain.emit('search-stickies')}
    );
    Menu.buildFromTemplate(items).popup({window: entry.win});
  });
  // OAuth that navigates the MAIN frame (not a popup) → punt to the system
  // browser, same as the old <webview> path.
  const oauthBail = (e: Electron.Event, url: string) => {
    if (isOAuthUrl(url)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  };
  wc.on('will-navigate', oauthBail);
  wc.on('will-redirect', oauthBail);
  // Popups / target=_blank / window.open. OAuth → system browser; everything
  // else → split a new web pane below this one (renderer owns the layout).
  wc.setWindowOpenHandler(({url}) => {
    if (isOAuthUrl(url)) {
      void shell.openExternal(url);
      return {action: 'deny'};
    }
    entrySend(uid, 'web-pane:open-split', {uid, url});
    return {action: 'deny'};
  });
}

function entrySend(uid: string, channel: string, payload: unknown) {
  const entry = panes.get(uid);
  if (!entry || entry.win.isDestroyed()) return;
  entry.win.webContents.send(channel, payload);
}

function roundRect(b: {x: number; y: number; width: number; height: number}) {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height))
  };
}

function createPane(win: BrowserWindow, uid: string, url: string) {
  if (panes.has(uid)) {
    const entry = panes.get(uid)!;
    // A React remount (sibling pane closed → BSP reparent, or any layout
    // reshuffle) fires destroy+create for the SAME pane. Cancel the pending
    // teardown and REUSE the live view — reloading would wipe page state
    // (e.g. the agent chat log).
    if (entry.destroyTimer) {
      clearTimeout(entry.destroyTimer);
      entry.destroyTimer = undefined;
    }
    const current = entry.view.webContents.getURL();
    if (url && url !== entry.url && url !== current) {
      entry.url = url;
      void entry.view.webContents.loadURL(url).catch(() => {});
    }
    entry.view.setVisible(entry.visible);
    return;
  }
  const view = new WebContentsView({
    webPreferences: {
      session: getSharedSession(),
      // The page is untrusted content — keep it isolated (opposite of the host
      // window's nodeIntegration:true chrome).
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });
  // White ground avoids the black-flash-between-repaints the old <webview> hit.
  view.setBackgroundColor('#ffffff');
  win.contentView.addChildView(view);
  const entry: WebPaneEntry = {view, win, url, visible: true};
  panes.set(uid, entry);
  wireWebContents(uid, view.webContents);
  if (url) void view.webContents.loadURL(url).catch(() => {});
}

// Lay out the page view (and, when open, the docked DevTools view below it)
// within the pane's last-known rect.
function positionViews(entry: WebPaneEntry) {
  const b = entry.lastBounds;
  if (!b) return;
  if (entry.devtools) {
    const dtH = Math.min(b.height, Math.max(80, Math.round(b.height * DEVTOOLS_FRACTION)));
    const pageH = Math.max(0, b.height - dtH);
    entry.view.setBounds({x: b.x, y: b.y, width: b.width, height: pageH});
    entry.devtools.setBounds({x: b.x, y: b.y + pageH, width: b.width, height: dtH});
  } else {
    entry.view.setBounds(b);
  }
}

async function screenshotPane(uid: string) {
  const entry = panes.get(uid);
  if (!entry) return;
  try {
    const img = await entry.view.webContents.capturePage();
    if (img.isEmpty()) return;
    clipboard.writeImage(img);
    try {
      const dir = join(homedir(), '.hyperia', 'snapshots');
      mkdirSync(dir, {recursive: true});
      let host = 'page';
      try {
        host = new URL(entry.view.webContents.getURL() || entry.url).hostname || 'page';
      } catch {
        /* keep 'page' */
      }
      writeFileSync(join(dir, `webshot-${host}-${Date.now()}.png`), img.toPNG());
    } catch {
      /* clipboard copy already succeeded; disk save is best-effort */
    }
  } catch {
    /* ignore */
  }
}

// Inspect → dock DevTools into the bottom of THIS pane (a real in-pane split,
// which a <webview> guest could never do). Renders DevTools into a second
// WebContentsView we position under the page.
function openInspector(uid: string, x: number, y: number) {
  const entry = panes.get(uid);
  if (!entry || entry.devtools) return;
  try {
    const dt = new WebContentsView({webPreferences: {}});
    entry.win.contentView.addChildView(dt);
    entry.devtools = dt;
    entry.view.webContents.setDevToolsWebContents(dt.webContents);
    entry.view.webContents.openDevTools();
    positionViews(entry);
    dt.setVisible(entry.visible);
    try {
      entry.view.webContents.inspectElement(x, y);
    } catch {
      /* best effort */
    }
  } catch {
    entry.devtools = undefined;
  }
}

function closeInspector(uid: string) {
  const entry = panes.get(uid);
  if (!entry || !entry.devtools) return;
  const dt = entry.devtools;
  entry.devtools = undefined;
  try {
    entry.view.webContents.closeDevTools();
  } catch {
    /* ignore */
  }
  try {
    if (!entry.win.isDestroyed()) entry.win.contentView.removeChildView(dt);
  } catch {
    /* ignore */
  }
  try {
    if (!dt.webContents.isDestroyed()) dt.webContents.close();
  } catch {
    /* ignore */
  }
  positionViews(entry);
}

// Renderer-driven destroy is DELAYED: an unmount is often half of a remount
// (layout reparent). Hide immediately; kill for real only if no create() lands
// within the grace window. Window teardown uses immediate=true.
function destroyPane(uid: string, immediate = false) {
  const entry = panes.get(uid);
  if (!entry) return;
  if (!immediate) {
    entry.view.setVisible(false);
    if (entry.destroyTimer) clearTimeout(entry.destroyTimer);
    entry.destroyTimer = setTimeout(() => destroyPane(uid, true), 400);
    return;
  }
  if (entry.destroyTimer) clearTimeout(entry.destroyTimer);
  panes.delete(uid);
  if (entry.devtools) {
    try {
      if (!entry.win.isDestroyed()) entry.win.contentView.removeChildView(entry.devtools);
    } catch {
      /* ignore */
    }
    try {
      if (!entry.devtools.webContents.isDestroyed()) entry.devtools.webContents.close();
    } catch {
      /* ignore */
    }
  }
  try {
    if (!entry.win.isDestroyed()) entry.win.contentView.removeChildView(entry.view);
  } catch {
    /* window may already be tearing down */
  }
  try {
    // REQUIRED: WebContentsView webContents are not auto-destroyed.
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  } catch {
    /* ignore */
  }
}

// Tear down every pane belonging to a window (call on window close).
export function destroyPanesForWindow(win: BrowserWindow) {
  for (const [uid, entry] of panes) {
    if (entry.win === win) destroyPane(uid, true);
  }
}

/**
 * Register the IPC surface. Call once at startup. `deps.configureSession` is
 * window.ts's configureWebPaneSession, applied to the shared web-pane session.
 */
export function initWebPaneManager(deps: {configureSession: ConfigureSession}) {
  configureSession = deps.configureSession;

  const winOf = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    BrowserWindow.fromWebContents(e.sender);
  const wcOf = (uid: string) => panes.get(uid)?.view.webContents;

  ipcMain.on('web-pane:create', (e, {uid, url}: {uid: string; url: string}) => {
    const win = winOf(e);
    if (win) createPane(win, uid, url);
  });

  ipcMain.on(
    'web-pane:set-bounds',
    async (_e, {uid, bounds, visible, freeze}: {uid: string; bounds: any; visible: boolean; freeze?: boolean}) => {
      const entry = panes.get(uid);
      if (!entry) return;
      if (bounds) {
        entry.lastBounds = roundRect(bounds);
        positionViews(entry);
      }
      const wantVisible = visible !== false;
      if (entry.visible && !wantVisible) {
        entry.visible = false;
        if (freeze) {
          // Freeze-swap: capture the LIVE view and hand the still to the renderer
          // BEFORE hiding, so a DOM overlay (URL navigator / find bar / header
          // tooltip) paints over a frozen frame of the page instead of white.
          try {
            const img = await entry.view.webContents.capturePage();
            entrySend(uid, 'web-pane:frozen', {uid, shot: img.toDataURL()});
          } catch {
            entrySend(uid, 'web-pane:frozen', {uid, shot: null});
          }
        } else {
          // Off-screen (tab switched away) — no still needed; just hide.
          entrySend(uid, 'web-pane:frozen', {uid, shot: null});
        }
        if (panes.get(uid) === entry && !entry.view.webContents.isDestroyed()) entry.view.setVisible(false);
      } else if (!entry.visible && wantVisible) {
        entry.visible = true;
        entry.view.setVisible(true);
        entrySend(uid, 'web-pane:frozen', {uid, shot: null});
      } else {
        entry.view.setVisible(wantVisible);
      }
      // The docked inspector tracks the page's visibility.
      if (entry.devtools) entry.devtools.setVisible(entry.visible);
    }
  );

  ipcMain.on('web-pane:set-visible', (_e, {uid, visible}: {uid: string; visible: boolean}) => {
    panes.get(uid)?.view.setVisible(!!visible);
  });

  ipcMain.on('web-pane:destroy', (_e, {uid}: {uid: string}) => destroyPane(uid));

  ipcMain.on('web-pane:nav', (_e, {uid, action, url}: {uid: string; action: string; url?: string}) => {
    const wc = wcOf(uid);
    if (!wc) return;
    switch (action) {
      case 'load':
        if (url) void wc.loadURL(url).catch(() => {});
        break;
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        break;
      case 'reload':
        wc.reload();
        break;
      case 'reloadIgnoringCache':
        wc.reloadIgnoringCache();
        break;
      case 'stop':
        wc.stop();
        break;
    }
  });

  ipcMain.on('web-pane:zoom', (_e, {uid, factor}: {uid: string; factor: number}) => {
    const wc = wcOf(uid);
    if (wc) wc.setZoomFactor(Math.max(0.5, Math.min(3, factor)));
  });

  ipcMain.on('web-pane:find', (_e, {uid, text, forward, findNext}: {uid: string; text: string; forward?: boolean; findNext?: boolean}) => {
    const wc = wcOf(uid);
    if (wc && text) wc.findInPage(text, {forward: forward !== false, findNext: !!findNext});
  });

  ipcMain.on('web-pane:stop-find', (_e, {uid}: {uid: string}) => {
    wcOf(uid)?.stopFindInPage('clearSelection');
  });

  // Request/response channels (renderer awaits the result).
  ipcMain.handle('web-pane:execute-js', async (_e, {uid, code}: {uid: string; code: string}) => {
    const wc = wcOf(uid);
    if (!wc) return {ok: false, error: 'no such pane'};
    try {
      const result = await wc.executeJavaScript(code, true);
      return {ok: true, result};
    } catch (err) {
      return {ok: false, error: String((err as Error)?.message || err)};
    }
  });

  ipcMain.handle('web-pane:capture', async (_e, {uid}: {uid: string}) => {
    const wc = wcOf(uid);
    if (!wc) return null;
    try {
      const img = await wc.capturePage();
      return img.toDataURL();
    } catch {
      return null;
    }
  });
}
