
  GNOSIS TERMINAL — FULL TECHNICAL PLAN
  ======================================

  Hyper fork + Rust sidecar
  Agent-native terminal emulator


  ┌─────────────────────────────────────────────┐
  │  TABLE OF CONTENTS                           │
  │                                               │
  │  1. Current Inventory                         │
  │  2. The Hyper Fork                            │
  │  3. Electron App Detail                       │
  │  4. Stream Deck Integration                   │
  │  5. Repo Structure                            │
  │  6. Rust vs TypeScript Split                  │
  │  7. Build Phases                              │
  │  8. Migration Path                            │
  └─────────────────────────────────────────────┘


======================================================================
1. CURRENT INVENTORY
======================================================================

  Rust codebase: terminal/src/ — 8,342 lines, 22 files

  terminal/src/
  |
  |-- main.rs .............. 271 lines   Entry, args, startup
  |-- tui.rs ............. 1,714 lines   TUI (crossterm/ratatui)
  |-- chat.rs .............. 903 lines   Claude agent + tool_use loop
  |-- control.rs ........... 726 lines   HTTP API (tiny_http)
  |-- mcp.rs ............... 377 lines   MCP stdio server (rmcp, 17 tools)
  |-- panes.rs ............. 343 lines   Pane manager + layout tree
  |-- capture.rs ........... 302 lines   PNG screenshot renderer
  |-- ws.rs ................ 238 lines   WebSocket streaming
  |-- web.rs ............... 238 lines   Embedded xterm.js HTML
  |-- screen.rs ............ 220 lines   vt100 parser + screen dump
  |-- pty.rs ............... 169 lines   PTY spawn + I/O threads
  |-- logs.rs ............... 60 lines   Tracing ring buffer
  |
  `-- deck/ ............. ~2,800 lines   Stream Deck Plus
      |-- device_actor.rs .. 424 lines   HID thread (50ms poll)
      |-- visuals.rs ....... 754 lines   Boot anim, icons, glitch
      |-- agent.rs ......... 465 lines   Claude agent (phys input)
      |-- mcp.rs ........... 262 lines   MCP server (9 tools)
      |-- screenshot.rs .... 211 lines   Composite capture
      |-- http.rs .......... 190 lines   REST API (axum :9850)
      |-- config.rs ........ 117 lines   streamdeck.json loader
      |-- mod.rs ........... 100 lines   Init + orchestration
      |-- state.rs .......... 64 lines   Shared device state
      |-- device.rs ......... 52 lines   HID discovery
      `-- ticker.rs ......... 76 lines   Stock ticker animation


  TERMINAL CORE
  -------------

  Pane layout (what you see):

  +-- Tab Bar -- 1:bold fox -- 2:calm elk -- 3:dark owl ----------+
  |                                                                |
  |  +-- bold fox * ------------++-- calm elk ------------------+  |
  |  | $ cargo build            || $ git log --oneline          |  |
  |  |    Compiling gnosis..    || 344ee99 fix: trust proxy..   |  |
  |  |    Finished in 4.2s      || 0688359 zip naming: sess..   |  |
  |  | $                        ||                              |  |
  |  |    [FOCUSED CURSOR]      ||                              |  |
  |  +-------------------------++-------------------------------+  |
  |                                                                |
  |  Ctrl+B: prefix | `: console | HTTP :9090 | WS :9091          |
  +----------------------------------------------------------------+

  Layout tree (how it's stored):

      Split(V, 0.5)
       +-- Leaf(0)    "bold fox"
       `-- Leaf(1)    "calm elk"

  Deeper splits just nest:

      Split(V, 0.5)
       +-- Leaf(0)
       `-- Split(H, 0.5)
            +-- Leaf(1)
            `-- Leaf(2)

  PTY:
  - portable-pty spawns PowerShell/bash
  - Reader thread -> crossbeam channel -> screen buffer
  - Writer thread <- channel <- key input

  Screen:
  - vt100 crate parses ANSI escape sequences
  - ScreenDump = rows x cols of (char, CellAttr{fg,bg,bold,italic,underline})

  Layout:
  - Binary tree of Leaf(id) and Split{direction, ratio, first, second}
  - Insert = replace leaf with split
  - Remove = replace split with sibling

  Focus:
  - Single focused pane ID
  - Tab cycles through leaves in tree order
  - Ctrl+B 1-9 jumps by index

  Bells:
  - BEL (0x07) in non-focused pane sets bell flag
  - Yellow highlight in tab bar, cleared on focus

  Names:
  - Auto-generated "adjective animal" from seed table
  - Renameable via Ctrl+B r or API


  CHAT / AGENT
  ------------

  +-- Chat -- Logs --+-- 1:bold fox ---------------------------+
  |                   |                                         |
  | +-- Chat -------+|+-- Logs --------++-- bold fox * ------+ |
  | | You: list     ||| INFO HTTP ..   || $ ls -la           | |
  | | panes         ||| INFO 127.0..   || total 48           | |
  | |               ||| INFO POST ..   || -rw-r Cargo.toml   | |
  | | AI:           |||                || drwxr src/          | |
  | | > Checking    |||                ||                    | |
  | |   layout      |||                ||                    | |
  | |               |||                ||                    | |
  | | 3 msgs | Tab  |||                ||                    | |
  | | > _           |||                ||                    | |
  | +--------------+|+----------------++--------------------+ |
  +-------------------------------------------------------------+

  Agent loop (chat.rs:641):

  User message
       |
       v
  +-------------------+
  | Compile system     |  DIYClaw prompt pack:
  | prompt from        |  base_system + execution + environment
  | 6 templates        |  + security + failure + agent role
  +---------+---------+  + screen context + pane name
            |
            v
  +-------------------+     +----------------+
  | POST anthropic     |---->| Claude API      |
  | /v1/messages       |<----| sonnet-4        |
  | (tools: 14)        |     | max_tokens:1024 |
  +---------+---------+     +----------------+
            |
            v
       +----+----+
       | text?   |--> Stream delta to chat panel
       +----+----+
            |
       +----+------+
       | tool_use? |--> Execute tool via HTTP
       +----+------+    (terminal_keys, file_read, etc.)
            |
            v
       Continue loop (max 15 steps)

  Budget enforcement:
  - 15 steps max
  - 120s wall time
  - 30 tool calls
  - 3 consecutive no-ops -> stop
  - 3 same-tool failures -> stop

  14 agent tools:

  Terminal         Console         File            Network
  -----------      -----------     -----------     -----------
  terminal_keys    console_open    file_read       web_fetch
  terminal_split   console_close   file_write
  terminal_focus   console_logs
  terminal_rename
  terminal_close
  terminal_status
  terminal_screen
  terminal_quit


  HTTP / WS / MCP
  ----------------

  HTTP :9090 (tiny_http)              WS :9091 (tungstenite)
  -----------------------             ----------------------
  GET  /health                        subscribe(pane) -> screen diffs
  GET  /api/status                    key(data) -> inject keystrokes
  GET  /api/panes
  GET  /api/screen?pane=N
  GET  /api/screenshot?pane=N
  GET  /stream?pane=N  (MJPEG)
  GET  /tail?pane=N&bytes=N
  POST /api/keys
  POST /api/pane/split
  POST /api/pane/close
  POST /api/pane/focus
  POST /api/pane/rename
  POST /api/resize
  POST /api/quit
  GET  /api/console/status
  GET  /api/console/logs
  GET  /api/console/messages
  POST /api/console/open
  POST /api/console/close
  POST /api/console/toggle
  POST /api/console/chat
  GET  /api/notifications
  GET  /                (xterm.js UI)
  GET  /watch           (read-only)

  MCP stdio (rmcp)                    Stream Deck :9850 (axum)
  ----------------                    -------------------------
  17 tools:                           GET  /health
  terminal_keys, terminal_run,        GET  /status
  terminal_screen, terminal_tail,     GET  /screenshot
  terminal_status, terminal_split,    POST /button/{key}/color
  terminal_focus, terminal_rename,    POST /touchstrip/color
  terminal_close, terminal_screenshot POST /touchstrip/text
  terminal_quit,                      POST /touchstrip/eye
  console_open, console_close,        POST /brightness
  console_toggle, console_chat,       GET  /test/button/{key}
  console_logs, console_messages,     GET  /test/brand
  console_status


  STREAM DECK PLUS
  ----------------

  +----------------------------------------------+
  |  Stream Deck Plus (hardware)                  |
  |                                               |
  |  +----+ +----+ +----+ +----+                 |
  |  | EYE| |PLSE| |TERM| |BOLT|  <- 120x120    |
  |  | 0  | | 1  | | 2  | | 3  |     LCD btns   |
  |  +----+ +----+ +----+ +----+                 |
  |  +----+ +----+ +----+ +----+                 |
  |  |BRAI| |WAVE| |GEAR| |GNOS|                 |
  |  | 4  | | 5  | | 6  | | 7  |                 |
  |  +----+ +----+ +----+ +----+                 |
  |                                               |
  |  (E0)   (E1)   (E2)   (E3)   <- rotary knobs|
  |  bright  scroll focus  free                   |
  |                                               |
  |  +------------------------------------------+|
  |  |  GNOSIS         800x100 touchstrip LCD   ||
  |  +------------------------------------------+|
  +----------------------------------------------+

  Boot: matrix rain (8s, CJK glyphs) -> brand icons -> flash home blue
  Events: broadcast channel -> Claude agent + terminal bridge
  Agent tools: set_button_color, set_button_image, set_touchstrip_text,
               set_touchstrip_color, set_touchstrip_eye, set_brightness,
               generate_image (Gemini 2.0 Flash)
  Glitch: every 4-18s, spectral shift / color sep / noise (80-280ms)


  IN PROGRESS
  -----------

  [x] Cargo.toml: reqwest blocking
  [x] tui.rs: pub(crate) render exports
  [ ] control.rs: /api/peer/register, /api/signal
  [ ] slave.rs: proxy TUI
  [ ] main.rs: startup probe
  [ ] chat.rs: agent_signal tool
  [ ] Stream Deck callback registry


======================================================================
2. THE HYPER FORK
======================================================================

  WHY
  ---

  Today (Rust TUI)            After (Hyper + Rust sidecar)
  -------------------         ---------------------------
  crossterm raw mode          Electron BrowserWindow
  ratatui widgets             React components + CSS
  8x8 bitmap font             System fonts + WebGL renderer
  No browser                  BrowserView (trivial)
  No CDP                      CDP over embedded browser
  Single window               Multi-window (free)
  No OS notifications         Electron Notification API
  No drag-drop                Electron drag-drop
  No auto-update              electron-updater
  No theming                  CSS + .hyper.js
  portable-pty (Rust)         node-pty (Hyper default)


  ARCHITECTURE: TWO PROCESSES
  ---------------------------

  +---------------------------------------------------------------+
  |  ELECTRON (Hyper fork)                                         |
  |                                                                |
  |  +-- Main Process ----------------------------------------+   |
  |  |                                                         |   |
  |  |  BrowserWindow management (multi-window)                |   |
  |  |  Sidecar lifecycle (spawn gnosis-server, health check)  |   |
  |  |  IPC bridge (renderer <-> main <-> sidecar)             |   |
  |  |  Session persistence (auto-save every 8s)               |   |
  |  |  Socket API server (named pipe / unix socket)           |   |
  |  |  node-pty spawn (with env injection)                    |   |
  |  |  Shell integration script injection                     |   |
  |  |  Desktop notifications                                  |   |
  |  |                                                         |   |
  |  +----------------------------+----------------------------+   |
  |                               | IPC                            |
  |  +-- Renderer Process --------v----------------------------+   |
  |  |                                                         |   |
  |  |  React component tree:                                  |   |
  |  |  +----------------------------------------------------+ |   |
  |  |  | <App>                                               | |   |
  |  |  |  +-- <Sidebar />          pane list + metadata      | |   |
  |  |  |  +-- <TerminalGrid />     xterm.js instances        | |   |
  |  |  |  +-- <AgentPanel />       chat + tool viz           | |   |
  |  |  |  +-- <NotificationPanel />                          | |   |
  |  |  |  +-- <CommandPalette />   fuzzy action search       | |   |
  |  |  |  +-- <BrowserPane />      embedded BrowserView      | |   |
  |  |  |  `-- <DeckPanel />        Stream Deck status        | |   |
  |  |  +----------------------------------------------------+ |   |
  |  |                                                         |   |
  |  |  Redux store:                                           |   |
  |  |  +-- panes: { layout, focused, metadata }               |   |
  |  |  +-- notifications: { [paneId]: Notification[] }        |   |
  |  |  +-- agent: { messages, loading, tools }                |   |
  |  |  +-- shell: { [paneId]: { cwd, git, ports, cmd } }     |   |
  |  |  +-- deck: { buttons, encoders, touchstrip }            |   |
  |  |  `-- workspaces: { current, list }                      |   |
  |  |                                                         |   |
  |  |  xterm.js addons:                                       |   |
  |  |  +-- ShellIntegrationAddon (OSC 7, 133, 777, 99)       |   |
  |  |  +-- WebLinksAddon                                      |   |
  |  |  `-- WebglAddon                                         |   |
  |  |                                                         |   |
  |  +---------------------------------------------------------+   |
  |                                                                |
  +-------------------------------+--------------------------------+
                                  |
                       HTTP :9090 + WS :9091
                                  |
  +-------------------------------v--------------------------------+
  |  GNOSIS-SERVER (Rust sidecar binary)                            |
  |                                                                |
  |  +-- Agent Engine -----------------------------------------+   |
  |  |  Claude API (tool_use loop, streaming)                   |   |
  |  |  Execution contracts (steps, time, tools, no-op, fail)   |   |
  |  |  Prompt pack compiler (DIYClaw 6-template system)        |   |
  |  |  Tool executor (terminal, file, web, signal, browser)    |   |
  |  +----------------------------------------------------------+   |
  |                                                                |
  |  +-- MCP Server (stdio) --+  +-- Peer System --------+        |
  |  |  17+ tools              |  |  /api/peer/register    |        |
  |  |  Claude Code, Cursor    |  |  /api/signal           |        |
  |  +-------------------------+  |  /api/peer/list        |        |
  |                               +------------------------+        |
  |  +-- Stream Deck (:9850) ---------------------------------+   |
  |  |  HID device actor (50ms poll)                           |   |
  |  |  Claude agent (button/encoder/touch -> visuals)         |   |
  |  |  Callback registry (webhooks to Electron)               |   |
  |  |  Encoder bindings (knob -> parameter -> callback)       |   |
  |  |  Visual pipeline (icons, glitch, ticker, alerts)        |   |
  |  +----------------------------------------------------------+   |
  |                                                                |
  |  +-- HTTP API (:9090) ------------------------------------+   |
  |  |  /api/agent/chat         (Electron -> agent)            |   |
  |  |  /api/agent/status       (loading, step count)          |   |
  |  |  /api/signal             (peer messaging)               |   |
  |  |  /api/peer/*             (registration, listing)        |   |
  |  |  /api/notify             (agent -> notification)        |   |
  |  |  /api/deck/*             (proxy to deck)                |   |
  |  |  /api/tools/execute      (run tool on demand)           |   |
  |  |  /health                                                |   |
  |  +----------------------------------------------------------+   |
  |                                                                |
  |  +-- Fallback TUI ----------------------------------------+   |
  |  |  gnosis-server --tui  (SSH/headless, uses existing       |   |
  |  |  tui.rs + screen.rs + panes.rs with portable-pty)        |   |
  |  +----------------------------------------------------------+   |
  +----------------------------------------------------------------+


  COMMUNICATION FLOW
  ------------------

  User types in terminal:

  xterm.js (renderer)
       | onData callback
       v
  node-pty (main process)
       | write to PTY fd
       v
  Shell (PowerShell/bash/zsh)
       | stdout
       v
  node-pty onData
       |
       +---> xterm.js (render output)
       |
       `---> ShellIntegrationAddon
               | parse OSC sequences
               v
             Redux store update
             { cwd, git_branch, command, exit_code }


  User sends chat message:

  AgentPanel (renderer)
       | POST localhost:9090/api/agent/chat
       v
  gnosis-server
       | agent_loop()
       +---> Claude API (tool_use)
       |         |
       |    +----v----+
       |    | tool_use |---> Execute tool
       |    | response |<--- (HTTP back to Electron,
       |    +----+----+     or file I/O, or web_fetch)
       |         |
       |    Stream text deltas
       v         v
  AgentPanel renders streamed response


  Stream Deck button press:

  device_actor (Rust, HID thread)
       | broadcast DeviceEvent
       +---> Deck Claude agent (visual response)
       |         |
       |    set_button_color, generate_image, etc.
       |
       `---> Callback registry
               | POST to registered URLs
               v
          Electron receives event -> Redux + notification


======================================================================
3. ELECTRON APP DETAIL
======================================================================

  SIDEBAR
  -------

  +---------+ +-------------------------------------------+
  | GNOSIS  | |                                           |
  |         | |  $ cargo build                            |
  | +-----+ | |     Compiling gnosis-terminal v0.1.0      |
  | |1 fox|<+-|     Finished `dev` in 4.2s                |
  | |main | | |  $                                        |
  | | *2  | | |                                           |
  | +-----+ | |                                           |
  | +-----+ | |                                           |
  | |2 elk| | |                                           |
  | |feat/x | |                                           |
  | |:3000| | |                                           |
  | +-----+ | |                                           |
  | +-----+ | |                                           |
  | |3 owl| | |                                           |
  | |~drt | | |                                           |
  | +-----+ | |                                           |
  |         | |                                           |
  | + new   | |                                           |
  |         | |                                           |
  | AGENT o | |                                           |
  | DECK  o | |                                           |
  +---------+ +-------------------------------------------+

  Sidebar entry anatomy:

  +-----------------------+
  | 1  bold fox           |  <- index + name
  | # main  *2            |  <- git branch + notif count
  | :3000 :5173           |  <- listening ports
  | ######....  62%       |  <- progress bar (optional)
  +-----------------------+

  React: <Sidebar>
  - Pane list from Redux panes.layout
  - Git branch + dirty from Redux shell[paneId].git
  - Port badges from Redux shell[paneId].ports
  - Notification count from Redux notifications[paneId].unread
  - Progress bar from Redux panes.metadata[paneId].progress
  - Click to focus, drag to reorder
  - "+ new" button spawns pane
  - Bottom: AGENT (toggle agent panel), DECK (toggle deck panel)


  AGENT PANEL
  -----------

  +-- Agent -------------------------------------------------+
  |                                                           |
  |  You: list all panes and their git branches               |
  |                                                           |
  |  AI:                                                      |
  |  +-- terminal_status --------------------------------+    |
  |  | ok: 3 panes: fox (main), elk (feat/x), owl (dev) |    |
  |  +---------------------------------------------------+    |
  |                                                           |
  |  Here are your panes:                                     |
  |  - bold fox -- main branch, clean                         |
  |  - calm elk -- feat/x branch, :3000 listening             |
  |  - dark owl -- dev branch, dirty                          |
  |                                                           |
  |  ---------------------------------------------------------|
  |  Thinking... step 2/15 | 3 tool calls | 4.2s             |
  |  +---------------------------------------------------+    |
  |  | > _                                               |    |
  |  +---------------------------------------------------+    |
  +-----------------------------------------------------------+

  React: <AgentPanel>
  - Chat messages with role coloring (user=green, assistant=cyan)
  - Tool call cards: collapsible, show name/input/output/status
  - Streaming text (SSE or WS from gnosis-server)
  - Status bar: step count, tool calls, elapsed, budget left
  - Input bar, Enter to send
  - Toggle with backtick or sidebar icon


  NOTIFICATION SYSTEM
  -------------------

  Notification ring (CSS glow on pane border):

  +-- calm elk -------------------------+
  |                                     |  <- normal (1px gray)
  +-------------------------------------+

  +== calm elk BELL ====================+
  ||                                   ||  <- unread (2px blue glow
  +=====================================+     + subtle pulse)

  +== calm elk ERR =====================+
  ||                                   ||  <- error (2px red glow)
  +=====================================+

  Sources that feed the notification system:

  BEL (0x07) -------+
  OSC 777 (RXVT) ---+
  OSC 99  (Kitty) --+--> Notification Store (Redux)
  Agent API ---------+      |
  Stream Deck -------+      |  { paneId, title, body,
                             |    level, timestamp, read }
                             |
                        +----v------+
                        | Render:   |
                        | - Ring    |
                        | - Badge   |
                        | - Panel   |
                        | - Desktop |
                        +-----------+

  Notification panel (Cmd+Shift+I):

  +-- Notifications -----------------------------------+
  |                                                    |
  |  * calm elk  2m ago                                |
  |    Build failed: exit code 1                       |
  |                                                    |
  |  * dark owl  5m ago                                |
  |    Tests passed (42/42)                            |
  |                                                    |
  |  o bold fox  12m ago                               |
  |    Agent completed: 3 files modified               |
  |                                                    |
  |  ------------------------------------------------ |
  |  * = unread   o = read   Enter to jump             |
  +----------------------------------------------------+


  BROWSER PANES
  -------------

  +---------+ +----------------++-------------------------+
  | 1 fox   | |                || <- -> (r)  localhost:3k |
  | # main  | | $ npm run dev  || +---------------------+ |
  |         | |   VITE v5.0    || |                     | |
  | 2 elk   | |   Local: :3000 || |   Welcome to        | |
  | :3000   | |                || |   My App            | |
  |         | |                || |                     | |
  | 3 web   | |                || |  [Login]            | |
  |         | |                || |                     | |
  |         | |                || +---------------------+ |
  | + new   | |                ||                         |
  +---------+ +----------------++-------------------------+
                                   ^
                                   |
                  BrowserView = Chromium renderer inside
                  Electron. Same engine as Chrome. Full
                  DevTools. CDP access.

  Agent browser tools (gnosis-server MCP + tool_use):

  browser_open(url)              Open browser pane, navigate
  browser_navigate(url)          Navigate existing browser
  browser_screenshot()           Capture page -> base64 PNG
  browser_click(selector)        Click DOM element
  browser_type(selector, text)   Type into input
  browser_fill(selector, value)  Set input value
  browser_eval(js)               Execute JS, return result
  browser_snapshot()             Accessibility tree dump
  browser_wait(selector, ms)     Wait for element
  browser_select(selector, val)  Select dropdown
  browser_scroll(x, y)           Scroll page
  browser_back()                 Navigate back
  browser_forward()              Navigate forward
  browser_cookies()              List cookies
  browser_storage(key?)          Read localStorage

  How it works: Electron main process creates BrowserView,
  attaches to pane rect. CDP via webContents.debugger.attach().
  Agent tools in gnosis-server POST to Electron main via IPC
  bridge, which executes CDP commands and returns results.


  SHELL INTEGRATION
  -----------------

  Shell startup:

  node-pty spawns shell with extra env:
       GNOSIS_PORT=9090
       GNOSIS_PANE_ID=0
       GNOSIS_WS_PORT=9091
       GNOSIS_SOCKET=/tmp/gnosis-9090.sock

  Then injects: source ~/.gnosis/shell/gnosis.bash
  (or gnosis.zsh / gnosis.ps1)

  What gnosis.bash does:

      __gnosis_precmd() {
        local exit_code=$?
        printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"   # CWD
        printf '\e]133;D;%s\a' "$exit_code"              # cmd done
        printf '\e]133;A\a'                               # prompt start
      }

      __gnosis_preexec() {
        printf '\e]133;C\a'                               # cmd start
      }

      PROMPT_COMMAND="__gnosis_precmd;$PROMPT_COMMAND"
      trap '__gnosis_preexec' DEBUG

  xterm.js ShellIntegrationAddon parses these:

      OSC 7   -> update Redux shell[paneId].cwd
      OSC 133 -> track command boundaries + exit codes
      OSC 777 -> route to notification system
      OSC 99  -> route to notification system

  CWD change triggers background checks:

      exec('git rev-parse --abbrev-ref HEAD')
         -> shell[paneId].git.branch = "main"

      exec('git status --porcelain')
         -> shell[paneId].git.dirty = true/false

      exec('netstat -tlnp 2>/dev/null')
         -> shell[paneId].ports = [3000, 5173]


  COMMAND PALETTE
  ---------------

  +---------------------------------------------------+
  | > split                                            |
  |                                                    |
  |   Split Vertical          Ctrl+B v                 |
  |   Split Horizontal        Ctrl+B h                 |
  | > Focus: bold fox         Ctrl+B 1                 |
  |   Focus: calm elk         Ctrl+B 2                 |
  |   Focus: dark owl         Ctrl+B 3                 |
  |   Close Pane              Ctrl+B x                 |
  |   Rename Pane             Ctrl+B r                 |
  |   Zoom Toggle             Ctrl+B z                 |
  |   Toggle Agent Panel      `                        |
  |   Open Browser            Cmd+Shift+L              |
  |   Notifications           Cmd+Shift+I              |
  |   Quit                    Ctrl+B q                 |
  |                                                    |
  |   14 results                                       |
  +---------------------------------------------------+

  Cmd+Shift+P (or Ctrl+Shift+P on Win/Linux)
  Fuzzy match on action names + pane names + workspace names
  Enter to execute, Esc to dismiss, arrows to navigate


  SESSION PERSISTENCE
  -------------------

  Auto-save every 8s -> ~/.gnosis/sessions/default.json

  Contents:
  - Window bounds (x, y, width, height)
  - Workspace list, each with:
    - Layout tree (split directions + ratios + pane IDs)
    - Focused pane ID
    - Per-pane: name, cwd, shell, scrollback file path
  - Agent conversation history
  - Last prompt pack used

  On launch:
  1. Read ~/.gnosis/sessions/default.json
  2. Create windows with saved bounds
  3. Spawn PTYs with saved CWDs
  4. Rebuild layout tree
  5. Restore scrollback (optional, can be large)
  6. Resume agent conversation


  SOCKET API
  ----------

  Windows:  \\.\pipe\gnosis-terminal-{pid}
  Linux:    /tmp/gnosis-{pid}.sock

  Protocol: JSON-RPC 2.0 over newline-delimited JSON

  Request:  {"jsonrpc":"2.0","method":"panes.list","id":1}
  Response: {"jsonrpc":"2.0","result":[{"id":0,"name":"bold fox",...}],"id":1}

  Methods (~40):

  Window:
    windows.list, windows.create, windows.close, windows.focus

  Workspace:
    workspaces.list, workspaces.create, workspaces.select,
    workspaces.close, workspaces.rename, workspaces.next,
    workspaces.prev, workspaces.reorder

  Pane:
    panes.list, panes.create, panes.split, panes.close,
    panes.focus, panes.rename, panes.resize, panes.swap,
    panes.send_keys, panes.send_text, panes.read_screen,
    panes.clear, panes.metadata

  Notification:
    notify.create, notify.list, notify.clear, notify.read

  Agent:
    agent.chat, agent.status, agent.stop, agent.history

  Browser:
    browser.open, browser.navigate, browser.screenshot,
    browser.click, browser.type, browser.eval,
    browser.snapshot, browser.close

  Sidebar:
    sidebar.set_status, sidebar.set_progress, sidebar.log

  CLI wrapper (gnosis-cli):

  $ gnosis panes
  $ gnosis focus 2
  $ gnosis keys "ls -la\n" --pane 1
  $ gnosis notify "Build done" --level info
  $ gnosis agent "deploy to staging"
  $ gnosis browser open http://localhost:3000
  $ gnosis status


======================================================================
4. STREAM DECK INTEGRATION (ENHANCED)
======================================================================

  Current:                        After:
  --------                        ------
  Deck Claude agent               Deck Claude agent
  reacts to buttons               reacts to buttons
  sets visuals                    sets visuals
  (isolated)                      + forwards to Electron
                                  + receives from agents
                                  + encoder bindings

  Callback flow:

  Electron (on startup) --> POST :9850/api/callbacks/register
                             { url: "http://localhost:9090/api/deck-event",
                               id: "terminal",
                               events: ["button", "encoder", "touch"] }

  User twists encoder 2 (bound to "Agent Temp"):

  device_actor detects twist
       |
       +---> Deck agent: "Encoder 2 twisted +1, now 0.75"
       |     Agent: set_touchstrip_text("Temp: 0.75")
       |
       `---> POST localhost:9090/api/deck-event
             { from: "streamdeck", type: "encoder_value",
               payload: { encoder: 2, label: "Agent Temp", value: 0.75 } }
                  |
                  v
             Electron main process
                  |
                  +---> Redux: deck.encoders[2].value = 0.75
                  +---> AgentPanel: update temperature config
                  `---> DeckPanel: show encoder position

  Encoder bindings:

  Encoder  Label       Min    Max    Step
  -------  ---------   ----   ----   ----
  0        Bright      0      100    5
  1        Scroll      --     --     --
  2        Temp        0.0    1.0    0.05
  3        Volume      0      100    5


======================================================================
5. REPO STRUCTURE
======================================================================

  gnosis-terminal/
  |
  +-- app/                            Electron app (Hyper fork)
  |   +-- main/
  |   |   +-- index.ts                Window mgmt, app lifecycle
  |   |   +-- sidecar.ts              Spawn + manage gnosis-server
  |   |   +-- ipc.ts                  IPC handlers
  |   |   +-- session.ts              Auto-save/restore
  |   |   +-- socket-server.ts        Named pipe / Unix socket
  |   |   `-- pty-manager.ts          node-pty spawn + env inject
  |   |
  |   +-- renderer/
  |   |   +-- index.tsx               React entry point
  |   |   +-- components/
  |   |   |   +-- App.tsx             Root layout
  |   |   |   +-- Sidebar.tsx         Pane list + metadata
  |   |   |   +-- TerminalGrid.tsx    xterm.js in layout
  |   |   |   +-- TerminalPane.tsx    Single xterm + decorations
  |   |   |   +-- AgentPanel.tsx      Chat + tool viz + input
  |   |   |   +-- AgentToolCard.tsx   Collapsible tool display
  |   |   |   +-- NotificationRing.tsx  CSS glow border
  |   |   |   +-- NotificationPanel.tsx List modal
  |   |   |   +-- CommandPalette.tsx  Fuzzy action search
  |   |   |   +-- BrowserPane.tsx     Browser + omnibar
  |   |   |   `-- DeckPanel.tsx       Deck status display
  |   |   |
  |   |   +-- store/
  |   |   |   +-- index.ts           Redux setup
  |   |   |   +-- panes.ts           Layout + metadata + focus
  |   |   |   +-- notifications.ts   Per-pane ring buffer
  |   |   |   +-- agent.ts           Chat + loading state
  |   |   |   +-- shell.ts           CWD, git, ports
  |   |   |   +-- deck.ts            Button/encoder state
  |   |   |   `-- workspaces.ts      Workspace groups
  |   |   |
  |   |   +-- addons/
  |   |   |   +-- shell-integration.ts   OSC 7, 133
  |   |   |   `-- notification.ts        OSC 777, 99
  |   |   |
  |   |   `-- styles/
  |   |       +-- sidebar.css
  |   |       +-- agent-panel.css
  |   |       +-- notifications.css
  |   |       `-- command-palette.css
  |   |
  |   +-- package.json
  |   +-- tsconfig.json
  |   +-- webpack.config.js
  |   `-- .hyper.js                   Default config
  |
  +-- server/                         Rust sidecar
  |   +-- src/
  |   |   +-- main.rs                 HTTP server entry
  |   |   +-- agent.rs                Claude API + tool loop
  |   |   +-- prompt_pack.rs          DIYClaw compiler
  |   |   +-- tools.rs                Tool defs + executor
  |   |   +-- mcp.rs                  MCP stdio server
  |   |   +-- signal.rs               Peer register + msgs
  |   |   +-- http.rs                 HTTP API routes
  |   |   +-- tui.rs                  Fallback TUI
  |   |   +-- screen.rs               vt100 (fallback)
  |   |   +-- panes.rs                PTY manager (fallback)
  |   |   +-- pty.rs                  portable-pty (fallback)
  |   |   `-- deck/                   Stream Deck (existing)
  |   |       +-- mod.rs
  |   |       +-- device_actor.rs
  |   |       +-- agent.rs
  |   |       +-- visuals.rs
  |   |       +-- http.rs
  |   |       +-- mcp.rs
  |   |       +-- config.rs
  |   |       +-- state.rs
  |   |       +-- device.rs
  |   |       +-- screenshot.rs
  |   |       `-- ticker.rs
  |   |
  |   +-- Cargo.toml
  |   `-- diyclaw-prompt-pack/
  |       +-- base_system.txt
  |       +-- execution.txt
  |       +-- environment.txt
  |       +-- security.txt
  |       +-- failure.txt
  |       `-- agents/
  |           `-- gonff.txt
  |
  +-- cli/                            CLI tool
  |   +-- src/main.rs                 Socket/HTTP wrapper
  |   `-- Cargo.toml
  |
  +-- shell/                          Shell integration
  |   +-- gnosis.bash
  |   +-- gnosis.zsh
  |   `-- gnosis.ps1
  |
  `-- EVOLUTION.md                    This file


======================================================================
6. RUST vs TYPESCRIPT SPLIT
======================================================================

  Component                    Lang         Why
  ---------                    ----         ---
  Agent engine (Claude API)    Rust         Perf, contracts, existing
  MCP server (stdio)           Rust         rmcp framework
  Stream Deck (HID + viz)      Rust         hidapi, real-time, image
  Peer signaling               Rust         HTTP server exists
  Prompt pack compiler         Rust         Template processing
  Fallback TUI (SSH)           Rust         crossterm/ratatui
  CLI tool                     Rust         Fast startup, pipes

  Terminal UI (windows etc.)   TypeScript   Electron renderer, React
  xterm.js terminals           TypeScript   Hyper default
  Shell integration (OSC)      TypeScript   xterm.js addon
  Notifications                TypeScript   Electron API, React
  Browser panes + CDP          TypeScript   Electron-native
  Session persistence          TypeScript   Electron main, fs
  Command palette              TypeScript   React modal
  Socket API server            TypeScript   Node.js net module


======================================================================
7. BUILD PHASES
======================================================================

  PHASE 0: CURRENT SPRINT (Rust TUI)
  -----------------------------------
  Finish slave mode + signaling. This work transfers to sidecar.

  [x] Cargo.toml: reqwest blocking
  [x] tui.rs: pub(crate) render exports
  [ ] control.rs: /api/peer/register, /api/signal
  [ ] slave.rs: proxy TUI
  [ ] main.rs: startup probe
  [ ] chat.rs: agent_signal tool
  [ ] Stream Deck callback registry


  PHASE 1: FORK & SCAFFOLD (week 1-2)
  ------------------------------------

  1. Fork vercel/hyper
     Strip: hyper-store, analytics, update checks
     Keep: xterm.js, node-pty, React, Redux, Electron shell

  2. Sidebar component (replace tab bar)
     - Pane list with name + focus indicator
     - Click to focus, + button to create
     - Placeholder slots for git/ports/badges

  3. Agent panel component
     - Chat message list (user/assistant)
     - Input bar with Enter to send
     - POST to localhost:9090/api/agent/chat
     - SSE/polling for streamed response

  4. Sidecar integration
     - Electron main: spawn gnosis-server on startup
     - Health check loop (GET :9090/health)
     - Restart on crash (max 3 retries)
     - Kill on app quit

  5. Env injection
     - node-pty spawn options: env += GNOSIS_*

  Result:
  +---------+ +--------------------------------------+
  | GNOSIS  | |                                      |
  |         | | $ echo $GNOSIS_PORT                   |
  | 1 fox <-+-| 9090                                  |
  | 2 elk   | |                                      |
  |         | |                                      |
  | + new   | |                                      |
  |         | |                                      |
  | AGENT   | |                                      |
  +---------+ +--------------------------------------+


  PHASE 2: SHELL INTEGRATION & METADATA (week 3-4)
  -------------------------------------------------

  1. Shell integration scripts
     gnosis.bash, gnosis.zsh, gnosis.ps1

  2. xterm.js ShellIntegrationAddon
     Parse OSC 7 -> cwd, OSC 133 -> command boundaries

  3. Git detection (on CWD change)
     git rev-parse + git status -> branch + dirty

  4. Port scanning
     Periodic netstat parse -> port list

  5. Sidebar enrichment
     Git branch, port badges, CWD display

  Result:
  +---------+ +--------------------------------------+
  | 1 fox   | |                                      |
  | # main  | | $ cargo build                        |
  |         | |    Compiling...                       |
  | 2 elk   | |                                      |
  | # feat/x| |                                      |
  | :3000   | |                                      |
  |         | |                                      |
  | + new   | |                                      |
  +---------+ +--------------------------------------+


  PHASE 3: NOTIFICATIONS (week 5-6)
  ----------------------------------

  1. Notification store (Redux, per-pane ring buffer)
  2. OSC notification addon (parse 777, 99, BEL)
  3. Notification ring (CSS glow on pane border)
  4. Sidebar badges (unread count)
  5. Notification panel (Cmd+Shift+I, list + jump)
  6. Desktop notifications (Electron API, suppress when focused)
  7. API endpoint (POST /api/notify + agent tool)


  PHASE 4: BROWSER PANES (week 7-9)
  -----------------------------------

  1. BrowserPane component
     BrowserView positioned in pane rect, omnibar, Cmd+Shift+L

  2. CDP bridge
     webContents.debugger.attach, execute CDP from main process

  3. Agent browser tools (gnosis-server)
     browser_open, navigate, screenshot, click, type, eval,
     snapshot, wait (15 tools total)

  4. MCP browser tools
     Same tools for Claude Code / MCP clients

  Result:
  +---------+ +----------------++---------------------+
  | 1 fox   | | $ npm run dev  || <- -> localhost:3k  |
  | # main  | |   Local: :3000 || +-----------------+ |
  |         | |                || |   My App        | |
  | 2 web   | |                || |   [Login]       | |
  | :3000   | |                || +-----------------+ |
  +---------+ +----------------++---------------------+


  PHASE 5: PALETTE, SESSIONS, SOCKET (week 10-12)
  -------------------------------------------------

  1. Command palette (Cmd+Shift+P)
     Fuzzy search all actions + panes + workspaces

  2. Session persistence
     Auto-save 8s, restore on launch, named sessions

  3. Workspace system
     Named pane groups, Cmd+Shift+W to switch

  4. Socket API
     JSON-RPC over named pipe / unix socket, ~40 methods

  5. CLI tool (gnosis-cli)
     gnosis panes, gnosis focus, gnosis notify, etc.


  PHASE 6: POLISH & SHIP (week 13+)
  -----------------------------------

  1. Keybinding customization (JSON config + settings UI)
  2. Theming (extend .hyper.js, sidebar + agent colors)
  3. Stream Deck UI panel (button state, encoder viz, simulate)
  4. Auto-update (electron-updater)
  5. Distribution (NSIS installer, DMG, AppImage, .deb)


======================================================================
8. MIGRATION PATH
======================================================================

  TODAY                    TRANSITION              TARGET
  -----                    ----------              ------

  terminal/src/*.rs        server/src/*.rs          server/src/*.rs
  (TUI + agent + API       (same code refactored:   (sidecar binary:
   + deck + MCP)            agent out of chat.rs,    agent, MCP, deck,
                            HTTP -> axum,            signal, tools)
                            TUI -> --tui flag)

  (nothing)                app/ (new)               app/
                           (fork Hyper, add          (full Electron UI
                            sidebar, agent panel)     with browser, notifs
                                                      sessions, etc.)

  (nothing)                cli/ (new)               cli/
                           (socket/HTTP wrapper)     (gnosis CLI)

  (nothing)                shell/ (new)             shell/
                           (bash/zsh/ps1 scripts)    (integration)

  The Rust TUI never dies. It becomes gnosis-server --tui
  for headless servers and SSH sessions. Same agent, same
  tools, same Stream Deck — rendered in crossterm instead
  of Electron.


======================================================================

  gnosis-terminal =

    Hyper (Electron + xterm.js)
  + Claude agent engine (Rust sidecar)
  + MCP server (17+ tools)
  + Stream Deck Plus (HID + visuals + AI)
  + Shell integration (CWD, git, ports, commands)
  + Notification rings + badges + OS notifications
  + Browser panes + CDP automation
  + Agent panel with tool call visualization
  + Rich sidebar with metadata
  + Command palette
  + Session persistence
  + Socket API + CLI
  + Peer signaling (agent-to-agent)
  + DIYClaw prompt packs
  + Fallback TUI for SSH

  An agent-native terminal where the AI is a peer,
  not a plugin.

======================================================================
