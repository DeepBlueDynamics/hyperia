# Hyperia v0.17.0

The headline is the new **Event Stream API** — every terminal, tab, and web pane in Hyperia can now be streamed live over WebSockets to external renderers (built for a 3D "situation room", useful anywhere). Around it, a deep hardening run: close guards that stop you from killing live work, strict focus discipline so agents can never yank your view, recovery for lost sessions, and a stack of terminal/link/input fixes. 24 releases of work since v0.16.19, rolled into a minor bump for the new streaming surface.

## Event Stream API — stream Hyperia anywhere (new)

Four WebSocket endpoints on the sidecar (`ws://localhost:9800`), spec in `plan/specs/EVENT_STREAM_API.md`:

| Endpoint | What it streams |
|---|---|
| `/ws/wall` | **Every pane at once** — colorized cell-grid keyframes + row deltas, poll-coalesced to your `?fps`. Cheap overview for a monitor wall. |
| `/ws/pane/{id}` | **One pane, full fidelity** — raw PTY bytes (feed straight into xterm.js), seeded with the current screen. **Interactive**: send keystrokes back on the same socket. Explicit `resize` control frames so viewers reflow. |
| `/ws/pixels/{id}` | **Web panes** (no PTY) — JPEG frames captured at the client-requested `w×h`, so texture resolution is the LOD lever. Byte-identical frames skipped. |
| `/ws/tab/{id}` | **A whole tab** — a `tab-layout` manifest (each pane's BSP rect + type) plus every pane's stream multiplexed on one socket, tagged by `paneId`: terminals as colorized deltas, web panes as pixels. Input routes back by `paneId`. |

Terminals stream from the sidecar's vt100 mirror, so they keep streaming even on background tabs. Reads follow the existing anonymous-read policy; gate with `config.stream.requireToken`.

## Never lose work — close guards & session recovery (#148)

- **Closing a pane/tab/window or quitting now asks first** when a foreground program is running — including the case the old heuristic missed: an `ssh` session running a remote agent. The sidecar's OS-level process inspection is polled as the authoritative signal.
- The confirm is a **styled in-app modal** (Enter/Escape, dark theme) instead of a native OS dialog — with a native fallback so a close can never get stuck. Web panes are hidden while it's up, so it can't render *behind* a page.
- The **path bar locks** while a foreground program runs, even over ssh with shell integration.
- **Recover Panes** (Shell/File menu): live shells that lost their tab to a renderer crash/reload/desync — invisible but still running — reattach as tabs. An automatic reconcile sweep also brings true orphans back on its own, so sessions stop silently vanishing.

## Your focus is yours — agents can't steal it

- An agent navigating, evaluating JS in, or re-opening a web pane **never moves your view**. Web panes activate only on a **real click or keypress** in the pane (Electron `input-event`), never on programmatic focus. Opt back into the old behavior with `webPaneFocusOnNavigate: true`.
- Agent `open_web_pane` creates/refreshes its tab **in the background**; your own opens still activate.
- **Stray CR fix:** the two-phase agent message delivery (paste body → settle → Enter) could race your typing — the stale Enter drained into your TUI composer and dropped the cursor a line. A bare Enter is now withheld or glued to the agent's own queued message; it can never land inside your typing.

## Terminal & links

- **Link clicks are finally consistent** (#15): plain click **copies** the URL (toast appears at the click point), Ctrl/Cmd+click **opens** it, right-click shows the **link menu only**. Killed the QuickEdit right-click paste that dumped your clipboard into the shell, and the random scroll-jump from the dueling link providers.
- **OSC 52 clipboard**: programs like grok, tmux, and vim that copy via escape sequence now actually reach the system clipboard (with the "Copied!" toast).
- **Scrollback default raised 1,000 → 10,000 lines** (#80).

## Pickers & profiles

- **A new tab opens your configured `defaultProfile`** — not whatever profile the focused pane happens to be running (no more surprise SSH sessions inherited from the active pane).
- The picker's default shell honors `defaultProfile` over the remembered last-used shell; clicking a shell in the dropdown reliably launches it; the `S`/`W`/`A` quick-keys work in whichever picker pane you click.

## Web panes

- **Ctrl+R / F5 reload the page** (Shift bypasses the HTTP cache) — browser-standard, while the page has focus.
- Linux titlebar window controls restored; directory-picker default fixed.

## Toasts

- File-copy results are **stacking toasts**: new ones push earlier ones upward instead of replacing them, each auto-expires after 30 s, and each has a real close button.

## Signing & platforms

| Platform | Status |
|---|---|
| **Windows `.exe`** | **Authenticode-signed** (Azure Trusted Signing · DeepBlue Dynamics LLC) |
| **macOS `.dmg`/`.zip`** | Signed + notarized in CI (attached as the mac leg completes) |
| **Linux `.deb`/AppImage** | Unsigned |
