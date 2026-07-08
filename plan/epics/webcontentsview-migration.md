# Web Panes: `<webview>` → `WebContentsView` Migration (2026-07-01)

## Context
Hyperia renders every web pane with Electron's **`<webview>` tag** (`lib/components/web-pane.tsx:2713`,
enabled by `webviewTag: true` in `app/ui/window.ts:178`). `<webview>` is officially discouraged by
Electron — it's slower, architecturally fragile, lags Chromium features, and is the component behind
the "some pages break" reports (bot-wall/challenge loops, OAuth popup handoffs, render glitches, the
black-flash background workaround). The supported path is **`WebContentsView`** (the replacement for
the deprecated `BrowserView`), a real native Chromium view the **main process** positions with
`setBounds()` and attaches via `win.contentView.addChildView()`.

Pinned Electron: **41.3.0** (`package.json:111`) — `WebContentsView`/`BaseWindow` fully available
(added in 30/28). Reference sources: `memory/webcontentsview-migration-sources.md`.

### The one hard problem: occlusion
A `<webview>` is a DOM element, so Hyperia's React overlays (pane header, URL dropdown, find bar,
tooltips) layer over it with plain `z-index`. A `WebContentsView` is a **native view painted ON TOP
of the whole DOM layer** — so those same overlays get *buried behind the page*. Everything else in
this migration is mechanical; **this is the design decision that must be made first** (see §2).

---

## 1. What we keep vs. replace

### Keep (little/no change)
- **Session/UA/header spoofing** — `configureWebPaneSession()` (`app/ui/window.ts:80-112`): the Chrome
  UA + `onBeforeSendHeaders` sec-ch-ua client-hint rewrite is session-level, so it applies verbatim to
  `webContentsView.webContents.session`. Call it once on the shared partition. **This is our best
  anti-Cloudflare asset and it survives intact.**
- **MCP tool definitions + HTTP routes** (`sidecar/src/mcp.rs` `open_web_pane`, `web_pane_content`,
  `web_pane_eval`, `web_pane_mouse`, `terminal_web_click`, `terminal_web_reload`, `tab_image`) — they
  post to `/api/web-pane/*`; the sidecar↔main path is unchanged. Only the *main-side handler target*
  changes (a `WebContentsView.webContents` instead of a renderer round-trip to a `<webview>` — in fact
  this gets *simpler*; see §5).
- **Injected scripts** — `clickFnStr` / `ghostMouseFnStr` (`lib/utils/webview-scripts.ts`) and every
  `executeJavaScript` payload (bg-color probe, HTTP-status via Navigation Timing, slim-scrollbar CSS,
  page-read, sticky extract) run identically on `webContents.executeJavaScript(...)`.
- **The React chrome** — PaneBand, UrlNavigator, FindBar, AskAiView, the URL history picker stay as
  DOM components. We change *where the page renders*, not the surrounding UI.

### Replace
- The `<webview>` element → a per-pane `WebContentsView` owned by the main process.
- The `webviewRef` + all `wv.*` calls (~50, inventoried below) → messages to main that operate on the
  view's `webContents`.
- Guest-`webContents`-via-`@electron/remote` access (`web-pane.tsx:1118-1285`, `before-input-event`,
  `will-navigate`, `focus`) → main-process listeners on the owned `webContents` (drop `@electron/remote`
  for web panes entirely — cleaner and faster).
- The offscreen-inactive-tab trick (`terms.tsx` `left: -9999em`) → explicit `view.setVisible(false)` /
  `removeChildView` per active tab (native views can't be "parked" offscreen cheaply).

---

## 2. DECISION FIRST — the occlusion strategy

The persistent header vs. transient dropdowns split cleanly, so a **hybrid** is recommended:

**(a) Persistent header (PaneBand): inset the view.** The native view never owns the header strip —
its `setBounds` top starts *below* the PaneBand. The header always paints in the DOM above empty space.
No occlusion, no toggling. (PaneBand height is already a known strip.)

**(b) Transient overlays that cover live page area (URL navigator dropdown z-10000, FindBar z-10001,
loading spinner, pane-band pulse/tooltips): freeze-and-swap.** When such an overlay opens:
1. `webContents.capturePage()` → paint the still image into a DOM `<img>` filling the pane (we already
   call `capturePage` at `web-pane.tsx:709`).
2. `view.setVisible(false)` (native view hidden → DOM overlay now renders over the frozen image).
3. On overlay close: `setVisible(true)`, drop the image.
The page is idle while you pick a URL / type a find query anyway, so a frozen frame is invisible UX and
it makes **every existing React overlay work unchanged**. This is the lowest-risk path.

**(c) Window-level `fixed` overlays (consent modal z-100000, agent toasts z-99999, notifications):**
no action — they're a separate concern from panes, but a native view will still cover them. Same
freeze-swap on *any* web pane whenever a consent modal / toast is up (rare, short-lived), OR promote
these to a always-on-top child `BaseWindow`. **Recommend:** reuse freeze-swap (one mechanism).

**Alternative considered — "browser chrome in its own WebContentsView"** (render all Hyperia chrome in
a second native view layered above the page view, the pattern big Electron browsers use). Strictly more
correct (live page under live overlays) but a large refactor: the chrome must move into its own web
contents and re-plumb events. **Deferred** as a v2 if freeze-swap proves janky. Recommend starting with
the hybrid.

> **This is the call I need from you:** hybrid freeze-swap (recommended, ~fits current UI) vs. full
> chrome-in-overlay-view (heavier, best fidelity). The rest of the plan assumes hybrid.

---

## 3. Architecture

```
main process (app/)
  WebPaneManager                     # NEW — owns the native views
    partition 'persist:webpanes'     # one shared session, configureWebPaneSession() applied once
    views: Map<paneUid, WebContentsView>
    addChildView(win, view) / setBounds(view, rect) / setVisible / destroy
    per-view webContents listeners:  did-navigate(-in-page), page-title-updated,
      did-fail-load, did-stop/-start-loading, dom-ready, found-in-page,
      context-menu, setWindowOpenHandler (OAuth/_blank routing — reuse app/ui/window.ts:896-918)

renderer (lib/)
  WebPane component
    - NO <webview>; renders header + overlays + a placeholder <div ref=bodyRef>
    - measures bodyRef rect (getBoundingClientRect, extend existing ResizeObserver
      at web-pane.tsx:944) and, on any change/scroll/tab-switch/resize, sends
      IPC 'web-pane:set-bounds' {uid, x,y,w,h, visible}
    - forwards state pushed FROM main: title, url, loading, canGoBack/Forward,
      found-in-page counts, bg color, error
    - freeze-swap: on overlay-open → request capture, hide view, show <img>;
      on close → show view

sidecar (unchanged path): MCP tool → /api/web-pane/* → main → WebPaneManager
```

### Bounds flow (the new plumbing)
Renderer is the source of truth for geometry (it owns the flex/percentage split layout,
`split-pane.tsx:96-139`). Each web pane measures its body rect **relative to the window** and pushes
`{x,y,w,h,visible}` to main on: mount, ResizeObserver fire, tab activation, window resize, and overlay
open/close. Main calls `view.setBounds({x,y,width,height})`. Debounce/coalesce to one `setBounds` per
frame. Inactive-tab panes push `visible:false`.

---

## 4. Method-surface reimplementation (renderer `wv.*` → main)

All ~50 `wv.*` calls (full list in the exploration; anchors below) collapse to a handful of
main-process operations on `view.webContents`, invoked by IPC:

| Renderer today | New home |
|---|---|
| `loadURL` (379), `reload`/`reloadIgnoringCache` (257/259/1380/1798), `stop` (1317), `goBack`/`goForward` (296-322) | `webContents.*` via `web-pane:nav` IPC |
| `getURL`/`canGoBack`/`canGoForward` (242-271, 1017) | pushed from main on `did-navigate`; renderer no longer polls |
| `executeJavaScript` (bg color, HTTP status, scrollbar CSS, page-read, eval, click, ghost, sticky) (998-1522, 1775) | `webContents.executeJavaScript` in main; results returned over the same IPC/bridge reply |
| `capturePage` (709) | `webContents.capturePage` (also drives freeze-swap) |
| `findInPage`/`stopFindInPage` (660-693) + `found-in-page` (1088) | `webContents.findInPage`; counts pushed to renderer |
| `getZoomFactor`/`setZoomFactor` (1144-1621) | `webContents.setZoomFactor` via `web-pane:zoom` |
| `getWebContentsId` (1118/1389/1402) | gone — main owns the id, matches by paneUid |
| `insertText`, spellcheck dict, `openDevTools`, `inspectElement` (window.ts:785-877) | already main-side; attach to owned `webContents` |

### MCP control path gets *simpler* (§5)
Today: `web_pane_eval` → sidecar → main → `rpc.emit('web-pane-eval')` → **renderer** → `wv.executeJavaScript`
→ result back through renderer → main → sidecar (`app/bridge.ts:819-847`). After: main resolves the
paneUid → its `webContents.executeJavaScript` **directly**, returns the result — the renderer hop is
deleted. Same for content/mouse/click/reload/read. Fewer moving parts, lower latency, no
`web-pane-*-result` round-trips.

---

## 5. Lifecycle, cleanup & known gotchas
- **BREAKING (Electron): child `webContents` are NOT auto-destroyed** when the window closes or the view
  is removed. `WebPaneManager` MUST `view.webContents.close()`/destroy on pane close, tab close, window
  close, and app quit — or we leak renderer processes. Wire into the existing pane-close / `cleanup_pane`
  paths and `updateSessionLayout` (`app/bridge.ts:1219-1245`).
- **White background by default** — matches our current `#ffffff` workaround (`web-pane.tsx:2727`); keep
  setting `setBackgroundColor` per detected page bg to preserve the anti-black-flash behavior.
- **Context-menu crash** — known Electron issue [#44898](https://github.com/electron/electron/issues/44898):
  `Menu.popup()` on a `BaseWindow`/`WebContentsView` can crash. We use `BrowserWindow` (a `BaseWindow`
  subclass) so verify our right-click menu (`app/ui/window.ts:773-895`) still pops safely; if it crashes,
  popup against the main `BrowserWindow` explicitly.
- **AutoResize** is standardized now — we drive bounds manually from the renderer anyway, so ignore
  `setAutoResize`.
- **DevTools / OAuth / `_blank`** — reattach `setWindowOpenHandler` (`app/ui/window.ts:896-918`) and the
  OAuth `will-navigate`/`will-redirect` bail-outs to the owned `webContents`; behavior identical.
- **Drop `webviewTag: true`** from main window prefs once no `<webview>` remains (`app/ui/window.ts:178`);
  reconsider `nodeIntegration:true`/`contextIsolation:false` (174-179) for the web session (the page
  session should stay isolated — it already is a separate partition).

---

## 6. Phased build order (each phase ships + is testable)
1. **Manager + one static pane.** `WebPaneManager`, shared partition + `configureWebPaneSession`,
   create/attach/`setBounds`/`setVisible`/destroy. Renderer sends bounds from `bodyRef`. Header inset.
   Navigate one URL, no overlays yet. Proves geometry + session + cleanup.
2. **Navigation + state push.** back/forward/reload/stop/loadURL; push title/url/loading/canGo* to the
   header. Kill the renderer polling. OAuth/`_blank` handlers reattached.
3. **executeJavaScript surface.** bg-color, HTTP status, scrollbar CSS, page-read, sticky extract.
   Rewire the MCP path (`web_pane_content/eval/mouse/click/reload`) straight to `webContents` (§5).
   Ghost cursor + click scripts.
4. **Overlays via freeze-swap.** capture→`<img>`→hide/show wired to UrlNavigator, FindBar, spinner,
   pulse editor, tooltips, and consent-modal/agent-toast presence. Find-in-page counts.
5. **Splits + tabs + zoom + DevTools + context menu.** Multiple simultaneous views, per-tab
   show/hide (replace `left:-9999em`), split resize → live `setBounds`, zoom, right-click menu
   (verify #44898), pop-out-to-new-tab reparent.
6. **Remove `<webview>`** + `webviewTag`, delete `@electron/remote` web-pane usage, cleanup dead IPC
   (`web-pane-*-result` round-trips). Full regression.

---

## 7. Risks & rollback
- **Bounds drift / lag on fast resize or split-drag** — native view can trail the DOM by a frame. Mitigate:
  coalesce to one `setBounds`/frame; during an active split-drag, freeze-swap (show the image while
  dragging, restore on drop).
- **Occlusion UX** — if freeze-swap feels janky on some overlay, that specific overlay can fall back to
  view-inset instead. Decision (§2) is reversible per-overlay.
- **Rollback:** keep `<webview>` behind a feature flag (`useWebContentsView`) through phases 1–5 so we can
  flip back per session; only phase 6 removes it.
- **Multi-window / pop-out** — each `BrowserWindow` needs its own view attachment; `addChildView` is
  per-window. `WebPaneManager` must key views by (window, paneUid).

---

## 8. Verification
- Pages that break today under `<webview>` (collect the list from the user) render correctly under
  `WebContentsView`: Cloudflare-fronted sites, an OAuth login (Google), a target=_blank popup → split,
  an SPA (hash routes → `did-navigate-in-page`), a legacy bg-color page (HN).
- MCP: `open_web_pane`, `web_pane_content`, `web_pane_eval`, `terminal_web_click`, `web_pane_mouse`,
  `terminal_web_reload`, `tab_image` all still drive the page (now via main directly).
- Overlays: URL navigator, FindBar (Ctrl+F match counts), pulse editor, right-click menu, consent modal
  over a web pane — none buried.
- Layout: split a web pane next to a terminal and next to another web pane; drag the divider; switch
  tabs; resize the window; pop a web pane to a new tab. No stray/ghost views; process count returns to
  baseline after closing panes (cleanup check via Task Manager).
- `cargo check` (sidecar unaffected) + `npx tsc -b` per phase.

---

## 9. Open decisions for you
1. **Occlusion strategy (§2):** hybrid freeze-swap (recommended) vs. full chrome-in-overlay-view.
2. **Scope of first cut:** migrate all web panes at once, or gate behind `useWebContentsView` and dogfood
   on a few before removing `<webview>`? (Recommend the flag.)
3. **Electron version:** stay on pinned 41.3.0, or bump to latest stable first (I can pull the exact
   current version + its `WebContentsView`/`BaseWindow` breaking-change notes before we start).
4. Which specific pages are breaking today — so phase-8 verification targets the real failures.

## Critical files
- `lib/components/web-pane.tsx` — the `<webview>`, all `wv.*` calls, event/IPC listeners, overlays.
- `app/ui/window.ts` — `configureWebPaneSession` (80-112), `did-attach-webview` (754-919), context menu,
  `setWindowOpenHandler`, `webviewTag` (178).
- `app/bridge.ts` — web-pane bridge commands (458-468, 752-917, 1219-1245).
- `lib/components/split-pane.tsx`, `term-group.tsx`, `terms.tsx` — layout/bounds source.
- `lib/utils/webview-scripts.ts`, `lib/utils/web-pane-helpers.ts` — injected scripts + UA (reused).
- `sidecar/src/mcp.rs`, `sidecar/src/main.rs` — MCP web tools + routes (path unchanged; target simplified).
- NEW: `app/web-pane-manager.ts` (or `app/ui/web-pane-manager.ts`).
