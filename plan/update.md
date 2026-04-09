# Browser Feature — Implementation Plan

## Overview

Add a first-class embedded browser to Hyperia that lives alongside terminal tabs as a peer window type. The browser has its own tab bar (multiple pages open at once), can be screenshotted/controlled programmatically, and terminals can open URLs in it via command.

---

## Architecture

### New view type: `browser`

Today Hyperia has one view type — terminal sessions backed by `node-pty`. The browser introduces a second view type that shares the same top-level tab bar but renders an Electron `<webview>` instead of an xterm instance.

**Top-level tabs already support this pattern.** Each tab in the header is identified by a root term-group UID pointing to a session. The browser tabs would follow the same model: a root-group UID, but with a `type: 'browser'` discriminator so the renderer knows to mount a webview instead of a terminal.

### Component hierarchy

```
HeaderContainer (existing tab bar — terminals + browser tabs coexist)
  └─ Tab [type: 'term']     → TermGroup → xterm
  └─ Tab [type: 'browser']  → BrowserView (new)
                                 ├─ BrowserToolbar (URL bar, back/fwd/refresh, browser-tab strip)
                                 ├─ BrowserTabBar (tabs within the browser)
                                 └─ <webview> element
```

The browser is a **single top-level Hyperia tab** that contains its own internal tab bar for multiple pages — similar to how a terminal tab can have splits, a browser tab has sub-tabs for pages.

---

## Detailed design

### 1. Redux state additions

**`lib/reducers/browser.ts`** (new reducer)

```ts
type BrowserTab = {
  id: string;           // uuid
  url: string;          // current URL
  title: string;        // page title from <title> tag
  favicon: string;      // favicon URL
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

type BrowserSession = {
  uid: string;           // matches the top-level Hyperia tab UID
  tabs: BrowserTab[];
  activeTabId: string;
  partition: string;     // session partition for cookie isolation
};

type BrowserState = {
  sessions: Record<string, BrowserSession>;  // keyed by Hyperia tab UID
};
```

Add to `HyperState` in `typings/hyper.d.ts`:

```ts
export type HyperState = {
  ui: uiState;
  sessions: sessionState;
  termGroups: ITermState;
  browser: BrowserState;       // ← new
};
```

Add action constants in `typings/constants/browser.ts`:
- `BROWSER_SESSION_ADD` / `BROWSER_SESSION_REMOVE`
- `BROWSER_TAB_ADD` / `BROWSER_TAB_CLOSE` / `BROWSER_TAB_SET_ACTIVE`
- `BROWSER_NAVIGATE` / `BROWSER_UPDATE_STATE` (url, title, loading, canGoBack, etc.)

### 2. New components

**`lib/components/browser-view.tsx`** — Main browser container

```
┌──────────────────────────────────────────────┐
│ ← → ↻  [ https://example.com         ] ⚙   │  ← BrowserToolbar
├──────────────────────────────────────────────┤
│ Tab1 │ Tab2 │ Tab3 │ +                       │  ← BrowserTabBar
├──────────────────────────────────────────────┤
│                                              │
│              <webview>                       │  ← Electron webview tag
│                                              │
└──────────────────────────────────────────────┘
```

- **`lib/components/browser-toolbar.tsx`** — URL input with smart scheme detection (auto-add `https://` for domains, `http://` for localhost), back/forward/refresh buttons, a screenshot button.
- **`lib/components/browser-tab-bar.tsx`** — Internal tabs for multiple pages within one browser window. New-tab button. Close buttons. Drag to reorder.
- **`lib/components/browser-webview.tsx`** — Wraps the `<webview>` element. Handles event listeners (`did-navigate`, `did-start-loading`, `did-stop-loading`, `page-title-updated`, `page-favicon-updated`, `new-window`). Exposes imperative methods for screenshot, navigation, and JS injection.

**`lib/containers/browser.ts`** — Redux-connected container, similar to `containers/terms.ts`.

### 3. Webview integration

Use Electron's `<webview>` tag (not BrowserView, not iframe):

```tsx
<webview
  ref={webviewRef}
  src={url}
  partition={`persist:browser-${sessionUid}`}
  preload={browserPreloadPath}
  allowpopups="false"
/>
```

**Preload script** (`app/browser-preload.js`):
- Context menu handling (right-click → copy link, save image, inspect)
- Mouse button 3/4 → back/forward navigation via IPC
- `window.getSelection()` for copy support
- Block `window.open()` — redirect to new browser tab instead

**Security:**
- Each browser session gets its own `partition` for cookie/storage isolation
- `allowpopups="false"` — new windows intercepted and opened as browser tabs
- No `nodeIntegration` in the webview (Electron default)
- CSP headers respected by the webview naturally

### 4. Screenshot / programmatic control

Add an IPC API on the main process (`app/ui/window.ts`):

```ts
ipcMain.handle('browser:screenshot', async (_event, webContentsId: number) => {
  const wc = webContents.fromId(webContentsId);
  const image = await wc.capturePage();
  return image.toPNG();  // returns Buffer
});

ipcMain.handle('browser:execute-js', async (_event, webContentsId: number, code: string) => {
  const wc = webContents.fromId(webContentsId);
  return wc.executeJavaScript(code);
});

ipcMain.handle('browser:get-url', (_event, webContentsId: number) => {
  const wc = webContents.fromId(webContentsId);
  return wc.getURL();
});
```

The renderer component exposes these through the Redux store so any part of the app (including the sidecar bridge) can trigger them.

### 5. Terminal → Browser integration

Terminals can open URLs in the browser instead of the system browser. Two mechanisms:

**a) Link click override:**
In `lib/components/term.tsx`, the `WebLinksAddon` currently calls `shell.openExternal(url)`. Change this to dispatch a `BROWSER_NAVIGATE` action instead (or offer both via a config option `openLinksIn: 'browser' | 'system'`).

```ts
// In term.tsx where WebLinksAddon is configured:
const webLinksHandler = (event: MouseEvent, url: string) => {
  if (config.openLinksIn === 'browser') {
    // Dispatch to open URL in Hyperia's browser
    window.rpc.emit('browser:open-url', { url });
  } else {
    shell.openExternal(url);
  }
};
```

**b) CLI command / sidecar command:**
Add a new RPC event `browser:open-url` that the main process handles:

```ts
// In app/ui/window.ts, add to rpc handlers:
rpc.on('browser:open-url', ({ url, newTab }) => {
  // Find or create a browser Hyperia tab
  // Navigate to the URL
  rpc.emit('browser open', { url, newTab: newTab ?? true });
});
```

The sidecar bridge (`app/bridge.ts`) can also send `{ cmd: "BrowserOpen", url: "..." }` commands, giving the Rust agent engine control over the browser.

### 6. Sidecar bridge additions

In `app/bridge.ts`, add handlers for browser commands from the sidecar:

```ts
// New downstream commands the sidecar can send:
case 'BrowserOpen':
  // Open URL in browser tab
  break;
case 'BrowserScreenshot':
  // Capture page, send PNG back to sidecar
  break;
case 'BrowserExecJS':
  // Run JS in the page, return result
  break;
case 'BrowserNavigate':
  // back, forward, refresh, or goto URL
  break;
```

Upstream, send page events to the sidecar so it can observe:
```ts
// When a browser page loads, navigates, or changes title:
send({ type: 'BrowserEvent', tabId, url, title, event: 'did-navigate' });
```

### 7. Top-level tab discrimination

The existing tab system needs to know whether a tab is a terminal or a browser. Minimal change:

In `lib/reducers/sessions.ts`, add a `type` field to the session:

```ts
type session = {
  // ... existing fields ...
  type: 'term' | 'browser';  // ← new, defaults to 'term'
};
```

In `lib/components/terms.tsx` (or a new parent component), conditionally render:

```tsx
if (session.type === 'browser') {
  return <BrowserContainer uid={session.uid} />;
} else {
  return <TermGroup ... />;
}
```

The header tab component can show a globe icon for browser tabs and a terminal icon for term tabs.

---

## File changes summary

| Action | Path | What |
|--------|------|------|
| **New** | `lib/components/browser-view.tsx` | Main browser component |
| **New** | `lib/components/browser-toolbar.tsx` | URL bar + nav buttons |
| **New** | `lib/components/browser-tab-bar.tsx` | Internal browser tabs |
| **New** | `lib/components/browser-webview.tsx` | `<webview>` wrapper |
| **New** | `lib/containers/browser.ts` | Redux-connected browser |
| **New** | `lib/reducers/browser.ts` | Browser state reducer |
| **New** | `lib/actions/browser.ts` | Browser action creators |
| **New** | `typings/constants/browser.ts` | Action type constants |
| **New** | `app/browser-preload.js` | Webview preload script |
| **Edit** | `typings/hyper.d.ts` | Add `BrowserState` to `HyperState`, add `type` to `session` |
| **Edit** | `lib/reducers/index.ts` | Combine browser reducer |
| **Edit** | `lib/store/configure-store.ts` | Add browser reducer to store |
| **Edit** | `lib/components/terms.tsx` | Route to browser or term based on session type |
| **Edit** | `lib/components/tab.tsx` | Show icon based on tab type |
| **Edit** | `lib/components/term.tsx` | Link click → browser option |
| **Edit** | `app/ui/window.ts` | Add `browser:open-url`, `browser:screenshot`, `browser:execute-js` IPC handlers |
| **Edit** | `app/bridge.ts` | Add `BrowserOpen`, `BrowserScreenshot`, etc. sidecar commands |
| **Edit** | `app/commands.ts` | Add `browser:new-tab`, `browser:close-tab`, `browser:open-url` commands |

---

## Key design decisions

1. **Browser tabs live inside a single Hyperia tab** — not one Hyperia tab per URL. This keeps the top-level tab bar clean (you see "Terminal 1", "Terminal 2", "Browser") and the browser manages its own pages internally. This avoids the cramped waveterm problem.

2. **`<webview>` over BrowserView** — webview renders inline in the React tree, making layout straightforward. BrowserView is an overlay managed by the main process, which is harder to coordinate with React layout. Electron's webview is well-supported and gives us partition isolation, preload scripts, and all navigation APIs.

3. **Session partition per browser instance** — each browser Hyperia tab gets its own storage partition, so cookies/auth don't leak between browser tabs if you open multiple browser top-level tabs.

4. **Screenshots via `capturePage()`** — Electron's `webContents.capturePage()` returns a `NativeImage` that can be converted to PNG/JPEG. This is how the sidecar/agent can "see" what's on screen.

5. **URL opening is configurable** — users can choose whether terminal links open in the built-in browser or system browser. Default to built-in browser.

6. **Sidecar gets full browser control** — the Rust agent engine can open URLs, navigate, screenshot, and execute JS, making the browser a tool the agent can use for web research, testing, etc.
