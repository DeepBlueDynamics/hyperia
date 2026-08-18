# Hyperia v0.17.3

The v0.17 line — **v0.17.0 through v0.17.3** — in one release. The headline of the run is the **Event Stream API** (put any Hyperia terminal, tab, or web pane on any screen, live and interactive); v0.17.3 tops it off by fixing the consent prompt that could expire unseen and strand an agent waiting forever.

## New in v0.17.3 — consent prompts that never strand an agent

- **Pending approvals can't vanish anymore.** The cross-pane consent prompt auto-dismisses after 45 s (so a leaked prompt can never freeze web panes — that safety stays). Before: an unseen prompt simply *disappeared* — the agent waited forever ("the human is considering…") and you never knew anything had asked. Now it **collapses into a persistent 🛂 pill** ("*<agent> is waiting for approval — click to review*") that re-opens the full prompt.
- **The prompt re-opens by itself** when the agent re-asks or retries the gated action.
- **A stray click can no longer silently DENY.** Clicking outside the consent card used to count as a deny — and while a prompt was up, the invisible full-window backdrop ate every hover and click (the "my pane icons are broken" mystery). Backdrop clicks now just snooze the prompt to the pill; only the explicit Allow/Deny buttons decide.
- CI: macOS `.zip` artifacts now ship with releases (mac auto-update needs them); the Linux build leg got hard timeouts + a lock-resilient apt step after a runner hang wedged the v0.17.0 asset upload.

## The v0.17 run — everything since v0.16.19

### Event Stream API — stream Hyperia anywhere (v0.17.0)

Four WebSocket endpoints on the sidecar (`ws://localhost:9800`), spec in `plan/specs/EVENT_STREAM_API.md`:

| Endpoint | What it streams |
|---|---|
| `/ws/wall` | **Every pane at once** — colorized cell-grid keyframes + row deltas, coalesced to your `?fps`. Cheap overview for a monitor wall. |
| `/ws/pane/{id}` | **One pane, full fidelity** — raw PTY bytes (feed straight into xterm.js), seeded with the current screen. **Interactive**: send keystrokes back on the same socket. Explicit `resize` frames. |
| `/ws/pixels/{id}` | **Web panes** (no PTY) — JPEG frames at the client-requested `w×h`, so texture resolution is the LOD lever. |
| `/ws/tab/{id}` | **A whole tab** — a `tab-layout` manifest (each pane's split rect + type) plus every pane's stream multiplexed on one socket: terminals as colorized deltas, web panes as pixels. Input routes back by `paneId`. |

Built for a 3D operations room rendering live terminals on virtual monitors — usable by any dashboard, wall display, or game engine.

### Never lose work — close guards & session recovery

- Closing a pane/tab/window or quitting **asks first** when a foreground program is running — including an `ssh` session running a remote agent (the sidecar's OS-level process inspection is the authoritative signal).
- Styled in-app confirm modal (native fallback so a close can never get stuck); web panes can't cover it; the path bar locks while a program runs.
- **Recover Panes** (Shell/File menu) + an automatic reconcile sweep: live shells that lost their tab to a renderer crash/reload reattach as tabs instead of silently running invisible forever.

### Your focus is yours — agents can't steal it

- An agent navigating, JS-evaluating, or re-opening a web pane **never moves your view**; web panes activate only on a real click or keypress. (Opt back in with `webPaneFocusOnNavigate: true`.)
- An agent's message can never land inside your typing — a stale bare Enter is withheld or glued to the agent's own queued message (the "cursor dropped a line in my TUI composer" fix).

### Terminal & links

- **Consistent link clicks**: plain click copies (+ toast at the click point), Ctrl/Cmd+click opens, right-click shows the link menu only — no more clipboard dumps into the shell, no scroll jumps.
- **OSC 52 clipboard**: grok / tmux / vim escape-sequence copies reach the system clipboard.
- Scrollback default raised **1,000 → 10,000** lines.
- File-copy results are **stacking toasts** — new ones push earlier ones up, 30 s expiry, real close button.

### Profiles, pickers, web panes

- A new tab opens your **configured default profile** — never whatever the focused pane happens to be running (no more surprise SSH sessions).
- Picker: the configured default beats last-used; dropdown clicks land reliably; `S`/`W`/`A` quick-keys work in whichever picker you click.
- **Ctrl+R / F5 reload a web pane's page** (Shift bypasses cache), browser-standard.

## Signing & platforms

| Platform | Status |
|---|---|
| **Windows `.exe`** | **Authenticode-signed** (Azure Trusted Signing · DeepBlue Dynamics LLC) |
| **macOS `.dmg`/`.zip`** | Signed + notarized in CI |
| **Linux `.deb`/AppImage** | Unsigned |
