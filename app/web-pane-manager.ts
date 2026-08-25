// WebPaneManager — owns the native WebContentsView instances that replace the
// legacy <webview> tag (see plan/epics/webcontentsview-migration.md).
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
import {getConfig} from './config';

const PARTITION = 'persist:hyperia-web';
// DevTools docks into the bottom of the pane, taking this fraction of its height.
const DEVTOOLS_FRACTION = 0.4;
// Freeze-swap bridge: how long the frozen still and the native view overlap
// during a visibility flip, so neither a hide-before-paint nor a
// clear-before-recomposite leaves a one-frame hole that reads as a flash.
// ~3 frames at 60Hz — long enough to bridge the cross-process gap, short enough
// to stay imperceptible.
const SWAP_BRIDGE_MS = 50;

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
  // Monotonic token bumped on every freeze/unfreeze so a delayed swap step
  // (hide-after-still / clear-still-after-show) can tell whether a newer
  // transition superseded it and bail instead of racing.
  swapToken?: number;
}

// Keyed by pane uid (unique across windows).
const panes = new Map<string, WebPaneEntry>();

// Paused HTTP-auth challenges (wc 'login' events) awaiting the human's answer
// from the credential toast. Keyed by a one-shot id; the callback resumes (or
// fails) the paused network request. Credentials pass through Chromium's HTTP
// auth cache only — never logged, never persisted by us.
let authSeq = 0;
const pendingAuth = new Map<string, (username?: string, password?: string) => void>();

// Windows where every native web-pane view is force-hidden regardless of the
// renderer's desired visibility. Native WebContentsViews always paint ABOVE the
// renderer DOM, so a DOM overlay (the close-confirm modal) would be occluded by
// a crisp web pane sitting on top of it. While a window is suppressed we pull
// its web views off the screen so the DOM modal is visible and clickable.
const suppressedWins = new Set<number>();

// The visibility the native view should actually have right now: the renderer's
// desired state, unless the whole window is suppressed (modal up).
function nativeVisible(entry: WebPaneEntry): boolean {
  return entry.visible && !suppressedWins.has(entry.win.id);
}

// Force-hide (or restore) all web panes in a window — used to clear a native
// view out from over a DOM overlay (e.g. the close-confirm modal).
export function setWindowWebPanesSuppressed(win: BrowserWindow, suppressed: boolean): void {
  if (suppressed) suppressedWins.add(win.id);
  else suppressedWins.delete(win.id);
  for (const entry of panes.values()) {
    if (entry.win !== win) continue;
    if (!entry.view.webContents.isDestroyed()) entry.view.setVisible(nativeVisible(entry));
    if (entry.devtools) entry.devtools.setVisible(nativeVisible(entry));
  }
}
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

// Capture a web pane's CURRENT rendered frame as base64 JPEG at the requested
// size. Web panes have no PTY, so this is the only way to put one on a 3D
// monitor — it powers the /ws/pixels stream (the client requests w×h so we
// render at exactly the texture resolution; no wasted pixels). Front-facing/flat
// — the 3D scene applies the monitor's tilt via texture mapping. Returns '' when
// the pane isn't a live web pane or capture fails.
export async function capturePaneJpeg(uid: string, w: number, h: number, quality = 60): Promise<string> {
  const entry = panes.get(uid);
  if (!entry || entry.view.webContents.isDestroyed()) return '';
  try {
    let img = await entry.view.webContents.capturePage();
    if (img.isEmpty()) return '';
    if (w > 0 && h > 0) {
      img = img.resize({width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), quality: 'good'});
    }
    return img.toJPEG(Math.max(1, Math.min(100, Math.round(quality)))).toString('base64');
  } catch {
    return '';
  }
}

function navState(wc: WebContents) {
  return {url: wc.getURL(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward()};
}

// Panes get ADOPTED across React remounts (delayed-destroy + create re-keys the
// map), so a uid captured by wireWebContents closures can go STALE — lookups by
// it silently no-op (the invisible-context-menu bug). Resolve the CURRENT uid
// from the webContents every time.
function liveUidOf(wc: WebContents, fallback: string): string {
  for (const [id, e] of panes) {
    if (!e.view.webContents.isDestroyed() && e.view.webContents === wc) return id;
  }
  return fallback;
}

function wireWebContents(initialUid: string, wc: WebContents) {
  const u = () => liveUidOf(wc, initialUid);
  // When a webContents `focus` lands right after a load START, it's LOAD-induced
  // (the page finished loading — e.g. an AGENT navigated the pane), NOT a human
  // click — so it must NOT steal the human's view. Only a genuine mouse/keyboard
  // gesture in THIS pane activates it; agent- or page-initiated focus never does
  // (unless config.webPaneFocusOnNavigate opts in). (focus-never-steal)
  //
  // input-event fires for REAL input routed to this view (mouseDown/keyDown);
  // programmatic element.focus() / navigation auto-focus / an agent's
  // web_pane_eval fire NO input-event. So a human click IS the mouseDown here,
  // and we activate on THAT — not on the ambiguous webContents 'focus' event
  // (which also fires for the programmatic cases and was the focus-steal source).
  wc.on('input-event', (_e: Electron.Event, input: Electron.InputEvent) => {
    if (input.type === 'mouseDown' || input.type === 'keyDown') {
      const uid = u();
      entrySend(uid, 'web-pane:focus', {uid, activate: true});
    }
  });
  wc.on('did-start-loading', () => {
    pushState(u(), {loading: true, error: null});
  });
  wc.on('did-stop-loading', () => pushState(u(), {loading: false, ...navState(wc)}));
  wc.on('did-navigate', () => pushState(u(), {...navState(wc)}));
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
    if (isMainFrame) pushState(u(), {...navState(wc)});
  });
  wc.on('page-title-updated', (_e, title) => pushState(u(), {title}));
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED (user/redirect navigation), not a real failure.
    if (isMainFrame && errorCode !== -3) {
      pushState(u(), {loading: false, error: {code: errorCode, description: errorDescription, url: validatedURL}});
    }
  });
  wc.on('found-in-page', (_e, result) => {
    const uid = u();
    entrySend(uid, 'web-pane:found-in-page', {
      uid,
      active: result.activeMatchOrdinal,
      total: result.matches
    });
  });
  // Let the renderer run its dom-ready work (scrollbar CSS inject, bg-color probe)
  // via web-pane:execute-js — it can't observe the guest's dom-ready directly.
  wc.on('dom-ready', () => { const uid = u(); entrySend(uid, 'web-pane:dom-ready', {uid}); });
  // The webContents 'focus' event ALSO fires for PROGRAMMATIC focus (an agent's
  // web_pane_eval focusing an element, the page's own JS, a navigation
  // auto-focus) — indistinguishable here from a real click, and the source of the
  // focus-steal. So it NEVER activates on its own; genuine clicks activate via the
  // input-event handler above. Honored only for the explicit opt-in.
  wc.on('focus', () => {
    const focusSteal = !!(getConfig() as unknown as {webPaneFocusOnNavigate?: boolean}).webPaneFocusOnNavigate;
    if (focusSteal) {
      const uid = u();
      entrySend(uid, 'web-pane:focus', {uid, activate: true});
    }
  });
  // Zoom shortcuts pressed while the PAGE has focus never reach the renderer's
  // window (the native view captures them), so intercept Ctrl/Cmd +/-/0 here and
  // route to the renderer's zoom handlers (which own the zoom-factor state).
  wc.on('before-input-event', (event: Electron.Event, input: Electron.Input) => {
    if (input.type !== 'keyDown') return;
    // Browser-standard reload keys act on the PAGE, like a browser tab:
    // Ctrl/Cmd+R and F5 reload; +Shift bypasses the HTTP cache. preventDefault
    // also keeps the app accelerator (Ctrl+Shift+R = renderer reload) from
    // firing while the page owns the keyboard.
    if ((input.key.toLowerCase() === 'r' && (input.control || input.meta) && !input.alt) || input.key === 'F5') {
      event.preventDefault();
      if (input.shift) wc.reloadIgnoringCache();
      else wc.reload();
      return;
    }
    if (!(input.control || input.meta)) return;
    const k = input.key;
    let dir: 'in' | 'out' | 'reset' | null = null;
    if (k === '+' || k === '=' || k === 'Add') dir = 'in';
    else if (k === '-' || k === '_' || k === 'Subtract') dir = 'out';
    else if (k === '0') dir = 'reset';
    if (dir) {
      event.preventDefault();
      const uid = u();
      entrySend(uid, 'web-pane:zoom-key', {uid, dir});
    }
  });
  // Right-click menu — rebuilt on the native webContents (the old <webview>
  // guest handler in window.ts no longer fires). Reload / screenshot / copy /
  // paste / back-forward / copy-link / find / inspect-in-split / stickys.
  wc.on('context-menu', (_e: Electron.Event, params: Electron.ContextMenuParams) => {
    const uid = u();
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
      // Not offered when this pane IS the agent shell (renderer dedupes to a
      // single Hyperia Agent tab anyway — the item would just focus itself).
      ...(/\/shell\b/.test(wc.getURL()) ? [] : [{
        label: 'Hyperia Agent',
        click: () => {
          const port = process.env.HYPERIA_PORT || '9800';
          (entry.win as any).rpc?.emit('open web pane req', {url: `http://localhost:${port}/shell`});
        }
      } as Electron.MenuItemConstructorOptions]),
      {type: 'separator'},
      {label: 'New Stickys', click: () => void ipcMain.emit('new-sticky', {})},
      {label: 'Search Stickys', click: () => void ipcMain.emit('search-stickies')}
    );
    Menu.buildFromTemplate(items).popup({window: entry.win});
  });
  // HTTP auth challenge (Basic/Digest 401, proxy 407). Electron ships NO stock
  // credentials dialog — unhandled, the request simply dies and the site looks
  // broken. Park the Chromium callback and raise a credential toast in the
  // pane's DOM chrome; the request stays paused until the human answers.
  // Chromium caches accepted credentials in the session's HTTP auth cache, so
  // a realm prompts once per app run, not per request.
  wc.on('login', (event, details, authInfo, callback) => {
    event.preventDefault();
    const uid = u();
    const id = `auth_${++authSeq}`;
    pendingAuth.set(id, callback);
    entrySend(uid, 'web-pane:auth-request', {
      uid,
      id,
      host: authInfo.host || '',
      port: authInfo.port || 0,
      realm: authInfo.realm || '',
      scheme: authInfo.scheme || 'basic',
      isProxy: !!authInfo.isProxy,
      url: details.url || ''
    });
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
  // Popups / target=_blank / window.open. OAuth always → system browser.
  // Everything else is routed per `config.webPaneLinkTarget` (default "tab"):
  //   "tab"         → a new Hyperia tab (web pane)  ← default
  //   "split-right" → split a web pane to the right (VERTICAL)
  //   "split-down"  → split a web pane below (HORIZONTAL)
  wc.setWindowOpenHandler(({url}) => {
    if (isOAuthUrl(url)) {
      void shell.openExternal(url);
      return {action: 'deny'};
    }
    const liveUid = u();
    const target = ((getConfig() as unknown as {webPaneLinkTarget?: string}).webPaneLinkTarget) || 'tab';
    if (target === 'split-right' || target === 'split-down') {
      entrySend(liveUid, 'web-pane:open-split', {
        uid: liveUid,
        url,
        direction: target === 'split-right' ? 'VERTICAL' : 'HORIZONTAL'
      });
    } else {
      // Default: open the link in a new Hyperia tab.
      const entry = panes.get(liveUid);
      (entry?.win as unknown as {rpc?: {emit: (ch: string, p: unknown) => void}})?.rpc?.emit('open web pane req', {url});
    }
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
    entry.view.setVisible(nativeVisible(entry));
    return;
  }
  // Reparent with a NEW group uid (some layout collapses re-key the group):
  // adopt a pending-destroy view in the same window with the same URL instead
  // of building a fresh one — this is what preserves page state (chat logs).
  for (const [oldUid, entry] of panes) {
    if (entry.win === win && entry.destroyTimer && entry.url === url) {
      clearTimeout(entry.destroyTimer);
      entry.destroyTimer = undefined;
      panes.delete(oldUid);
      panes.set(uid, entry);
      entry.view.setVisible(nativeVisible(entry));
      return;
    }
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
  console.log(`[wp] createPane BUILT fresh uid=${uid.slice(0,8)} win=${win.id} childViews=${win.contentView.children.length}`);
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
    dt.setVisible(nativeVisible(entry));
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
  suppressedWins.delete(win.id);
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
        const token = entry.swapToken = (entry.swapToken ?? 0) + 1;
        if (freeze) {
          // Freeze-swap: capture the LIVE view and hand the still to the renderer
          // BEFORE hiding, so a DOM overlay (URL navigator / find bar / header
          // tooltip) paints over a frozen frame of the page instead of white.
          let shot: string | null = null;
          try {
            shot = (await entry.view.webContents.capturePage()).toDataURL();
          } catch {
            /* keep null */
          }
          entrySend(uid, 'web-pane:frozen', {uid, shot});
          // Hide the native view only AFTER giving the renderer a couple frames
          // to paint the still. Hiding it in the same tick as sending the still
          // left a one-frame hole (pane bg showed through before the <img>
          // painted) that flashed when mousing page → header. Bail if a newer
          // transition (re-show) superseded this one.
          setTimeout(() => {
            if (panes.get(uid) === entry && entry.swapToken === token && !entry.visible
                && !entry.view.webContents.isDestroyed()) {
              entry.view.setVisible(false);
            }
          }, SWAP_BRIDGE_MS);
        } else {
          // Off-screen (tab switched away) — no still needed; just hide now.
          entrySend(uid, 'web-pane:frozen', {uid, shot: null});
          if (panes.get(uid) === entry && !entry.view.webContents.isDestroyed()) entry.view.setVisible(false);
        }
      } else if (!entry.visible && wantVisible) {
        entry.visible = true;
        const token = entry.swapToken = (entry.swapToken ?? 0) + 1;
        entry.view.setVisible(nativeVisible(entry));
        // Keep the still up a couple frames while the native view re-composites,
        // THEN clear it. Clearing in the same tick as showing removed the <img>
        // a frame before the view painted, so the pane bg flashed through when
        // mousing header → page. Bail if a newer transition superseded this one.
        setTimeout(() => {
          if (panes.get(uid) === entry && entry.swapToken === token && entry.visible) {
            entrySend(uid, 'web-pane:frozen', {uid, shot: null});
          }
        }, SWAP_BRIDGE_MS);
      } else {
        entry.view.setVisible(wantVisible && !suppressedWins.has(entry.win.id));
      }
      // The docked inspector tracks the page's visibility.
      if (entry.devtools) entry.devtools.setVisible(nativeVisible(entry));
    }
  );

  ipcMain.on('web-pane:set-visible', (_e, {uid, visible}: {uid: string; visible: boolean}) => {
    const entry = panes.get(uid);
    if (entry) entry.view.setVisible(!!visible && !suppressedWins.has(entry.win.id));
  });

  ipcMain.on('web-pane:destroy', (_e, {uid}: {uid: string}) => destroyPane(uid));

  // Answer (or cancel) a paused HTTP-auth challenge. Cancel resumes the request
  // with no credentials — the page falls through to the server's 401 body.
  ipcMain.on(
    'web-pane:auth-response',
    (_e, {id, username, password, cancel}: {id: string; username?: string; password?: string; cancel?: boolean}) => {
      const cb = pendingAuth.get(id);
      if (!cb) return;
      pendingAuth.delete(id);
      try {
        if (cancel) cb();
        else cb(String(username ?? ''), String(password ?? ''));
      } catch {
        // webContents died while the toast was up — nothing left to resume.
      }
    }
  );

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
