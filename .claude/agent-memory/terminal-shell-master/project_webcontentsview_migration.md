---
name: webcontentsview-migration
description: Web panes migrating from Electron <webview> tag to a main-process WebContentsView; renderer rewire done, Phase 2/3 features deferred
metadata:
  type: project
---

Hyperia is replacing the legacy `<webview>` tag in web panes with a native `WebContentsView` owned by the MAIN process.

**Why:** `<webview>` paints black between repaints, loses `getWebContents()` in modern Electron (broke context menus / link handlers), and is generally deprecated. WebContentsView is the supported path.

**Architecture:** main (`app/web-pane-manager.ts`) owns the view instances keyed by pane uid (= `groupUid`); renderer (`lib/components/web-pane.tsx`) stays the source of truth for GEOMETRY and pushes pixel rects via `web-pane:set-bounds`. Page state (url/title/loading/canGo*) flows back via `web-pane:state` pushes. IPC contract lives at the top of `web-pane-manager.ts`. WebContentsView webContents are NOT auto-destroyed — main must `.close()` them (handled).

**How to apply:** The renderer no longer has a guest webContents to attach listeners to. Several features were intentionally left as `// TODO(webcontentsview Phase 2/3)` no-ops and need main-side rewiring keyed by pane uid:
- in-page keyboard shortcuts (Ctrl+F/zoom/split from inside the page — old `before-input-event`)
- OAuth `will-navigate`/`will-redirect` bail-out to system browser
- clicking INTO the page activating the pane / closing the URL navigator (old guest `focus`)
- right-click "Find in page" and target=_blank → split-down (old `web-pane-find` / `web-pane-open-split`, which correlated by guest `getWebContentsId()` — that id no longer exists)

Also deferred: hiding the native view while URL-navigator/find bar are open currently shows white (no screenshot-freeze polish yet).
