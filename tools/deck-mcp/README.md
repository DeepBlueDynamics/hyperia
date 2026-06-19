# deck-mcp

A **Windows-only** Rust daemon that turns an **Elgato Stream Deck Plus** into a physical
control surface for [Hyperia](../../README.md) — and exposes the deck itself as an MCP
server so agents can draw on it.

It runs as a standalone host process (not part of the Hyperia app/installer). It talks to
a running Hyperia instance over MCP, drives the Stream Deck hardware over USB HID, and
serves a browser "virtual deck" dashboard.

---

## What it does

The Stream Deck Plus has three input zones; `deck-mcp` maps them like this:

### Touch strip (the 800×100 LCD)
Shows the panes of Hyperia's **active tab**, four at a time, plus two trailing actions
(`+ Pane`, `+ Tab`). Each pane cell shows its name and a focus highlight.

- **Short tap** on a pane cell → `terminal_focus` that pane (switches Hyperia to its tab
  and focuses it). Tap `+ Pane` → `terminal_split` the focused pane. Tap `+ Tab` →
  `terminal_new_tab`.
- **Swipe** left/right → scroll the pane list when there are more than four.

### Dials (4 rotary encoders, press + rotate)
| Dial | Rotate | Press |
|------|--------|-------|
| 0 | Scroll the pane list | Focus pane in column 0 |
| 1 | Switch tabs in the active window (local view) | Focus pane in column 1 |
| 2 | Scroll the app list (the 8 keys) | Focus pane in column 2 |
| 3 | Adjust deck **brightness** (±5%) | Focus pane in column 3 |

### Keys (8 LCD buttons)
Show the **running Windows applications** (deduped by process, with extracted icons).

- **Press** → activate that app's window via Win32 `SetForegroundWindow`. If the app has
  multiple windows, repeated presses **cycle** through them (tracked per app).
- A red badge with a count is drawn on any app with more than one open window.
- Icons are extracted from each EXE via PowerShell + `user32!PrivateExtractIcons`; **Sonos**
  and **Explorer** get hand-supplied art (`src/sonos_icon.jpg`, `src/explorer_icon.jpg`),
  and Hyperia/Sonos render full-bleed (no label). The app list is sorted Hyperia → Sonos →
  Explorer → everything else.

---

## Architecture

```
                 ┌─────────────────────────────────────────────┐
                 │                 deck-mcp                      │
  Stream Deck    │  device.rs  ── USB HID (hidapi) ──┐           │
  Plus  ◄───USB──┤                                   │           │
                 │  main.rs  ── event loop, app scan, render     │
                 │     │                              │           │
                 │     ├── hyperia.rs ── MCP CLIENT ──┼──► Hyperia /mcp  (:9800)
                 │     │                              │           │
                 │  web.rs ── axum HTTP (:8080) ──────┘           │
                 │     ├── /        web dashboard (index.html)    │
                 │     ├── /mcp     MCP SERVER (mcp.rs tools) ◄──── agents draw on the deck
                 │     └── /ws      websocket (live sync + control)
                 └─────────────────────────────────────────────┘
```

### Module map
| File | Responsibility |
|------|----------------|
| `src/main.rs` | Entry point, shared `AppState`, the hardware-event loop, the Hyperia sync loop, the Windows app scan, button-image rendering, and Win32 window activation. |
| `src/device.rs` | Stream Deck Plus USB HID driver — `connect` (VID `0x0FD9`, PID `0x0084`), HID report parsing into `StreamDeckEvent` (touch / swipe / dial rotate / dial press / key press / disconnect), `set_brightness`, `fill_button_image` (key 0–7, 120×120), `fill_lcd_image` (region of the 800×100 strip), `reset_to_logo`. |
| `src/hyperia.rs` | **MCP client to Hyperia.** `HyperiaClient` reads `HYPERIA_URL`/`HYPERIA_AGENT_TOKEN`, runs the MCP handshake, and wraps `terminal_status`, `terminal_focus`, `terminal_run`, `terminal_split`, `terminal_new_tab`. Also defines the `Window → Tab → Pane` deserialization types. |
| `src/mcp.rs` | **MCP server tools** to control the physical deck (`set_button_image`, `set_touch_screen_image`) **and** the touch-strip renderer (`redraw_touch_bar` draws the 800×100 bar; `trim_pane_name`, `measure_text_width`). |
| `src/web.rs` | axum router: `/` (dashboard), `/mcp` (the deck's MCP server), `/ws` (websocket for the virtual deck — receives `set_brightness`/focus/run/split/dial/key/touch/swipe actions and pushes `Sync` events). |
| `src/index.html` | The browser "virtual deck" dashboard UI. |
| `src/{sonos,explorer}_icon.jpg` | Hand-supplied key art (read at runtime — see *Known limitations*). |

---

## The two MCP roles

**1. Client → Hyperia.** This is how the deck mirrors and controls your terminal. It calls
Hyperia's MCP server (default `http://localhost:9800/mcp`) using the standard 3-step
Streamable-HTTP handshake (`initialize` → `notifications/initialized` → `tools/call`) and
parses both `application/json` and `text/event-stream` responses.

**2. Server ← agents.** `deck-mcp` *also* exposes its own MCP server at
`http://localhost:8080/mcp` so an agent can paint the deck:

| Tool | Args | Effect |
|------|------|--------|
| `set_button_image` | `key` (0–7), `image` (base64 JPEG/PNG) | Sets a key image (auto-scaled to 120×120). |
| `set_touch_screen_image` | `image` (base64), optional `x`/`y`/`width`/`height` | Draws onto the 800×100 touch strip (region defaults to full bar). |

---

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `HYPERIA_URL` | `http://localhost:9800` | Base URL of the Hyperia MCP server. `/mcp` is appended. |
| `HYPERIA_AGENT_TOKEN` | _(empty)_ | Bearer token sent to Hyperia. Reading the pane list (`terminal_status`) and focusing are gate-free, but **split / new-tab need a valid token**. Reuse the token from `~/.hyperia/cli.json`, or mint a persistent agent token (`POST /api/identity/agent`). |

The deck's own web/MCP server binds **`0.0.0.0:8080`** (see *Known limitations*).

---

## Build

Requires the Rust stable toolchain (MSVC) on Windows.

```powershell
cd tools/deck-mcp
cargo build --release
# → target/release/deck-mcp.exe
```

First build pulls a fair number of crates (`tokio`, `axum`, `reqwest`, `image`, `hidapi`,
`rusttype`), so expect a few minutes.

## Run

> **Run it from this directory.** It loads `src/sonos_icon.jpg` / `src/explorer_icon.jpg`
> via *relative* paths, so the working directory must be `tools/deck-mcp/`.

```powershell
cd tools/deck-mcp
$env:HYPERIA_AGENT_TOKEN = (Get-Content $HOME/.hyperia/cli.json | ConvertFrom-Json).token
./target/release/deck-mcp.exe
```

On startup it prints either `Connected to Stream Deck Plus! Serial: …` or a warning that the
device wasn't found (in which case the web dashboard still runs, but the hardware stays
dark). Then:

- **Web dashboard:** <http://localhost:8080/>
- **Deck MCP server:** `http://localhost:8080/mcp`
- It polls Hyperia and redraws the deck every ~2 s; it rescans Windows apps every ~4 s; and
  it auto-reconnects if the deck is unplugged/replugged.

---

## Requirements

- **Windows** (uses `user32` FFI and inline-C#-via-PowerShell for window enumeration, icon
  extraction, and focus).
- An **Elgato Stream Deck Plus** specifically (VID `0x0FD9` / PID `0x0084`). Other Stream
  Deck models use a different HID layout and are not supported.
- A **running Hyperia** instance reachable at `HYPERIA_URL`.
- `PowerShell` on `PATH` and a system font (`C:\Windows\Fonts\segoeui.ttf`, falls back to
  `arial.ttf`) for label rendering.

---

## Known limitations / roadmap

These are tracked for the Hyperia integration and are deliberately called out:

- **Heavy polling.** State refresh is a 2 s poll of `terminal_status`, and *every* call does
  a full 3-step MCP handshake with a fresh HTTP client + session. Planned fix: a single
  reusable session (the sidecar is stateless-callable), and ultimately an **SSE subscribe**
  endpoint on the sidecar so the deck updates on change instead of on a timer.
- **App scan cost.** The Windows app/window scan spawns PowerShell and JIT-compiles inline
  C# (`Add-Type`) every ~4 s. Planned fix: native Win32 `EnumWindows` (already FFI'd for
  activation) + icon caching.
- **Working-directory coupling.** Icon assets are read by relative path; the daemon must be
  launched from `tools/deck-mcp/`. Planned fix: embed assets with `include_bytes!`.
- **Network exposure.** The HTTP/MCP/ws server binds `0.0.0.0:8080`. Bind `127.0.0.1` unless
  you intentionally want LAN access.
- **Token provisioning.** There's no turnkey "give this peripheral a standing token" flow
  yet; reuse `~/.hyperia/cli.json` or a minted agent token.
- **Lifecycle.** It runs in the foreground; there's no auto-start/service wrapper yet. To
  survive reboots, wrap it in a Windows startup task / Task Scheduler entry.

---

## Troubleshooting

- **`Failed to perform initial Hyperia sync: "No windows found in Hyperia status"`** — a
  harmless startup race: the first sync (≈3 s after launch) can beat Hyperia's window
  registration. The next 2 s poll picks it up. (Make sure Hyperia actually has a window
  open, not just a tray icon.)
- **`Stream Deck Plus (VID 0x0FD9, PID 0x0084) not found`** — the device isn't plugged in,
  is a different Stream Deck model, or is held by the official Stream Deck software (close
  it). The dashboard still serves on `:8080`.
- **Split / new-tab do nothing, but focus works** — you have no valid `HYPERIA_AGENT_TOKEN`;
  reads/focus are gate-free but state-changing actions need one.
- **Empty `terminal_status` from a manual `curl`** — Hyperia's `terminal_status` returns
  window data only inside an initialized MCP session; do the `initialize` handshake first
  (the daemon already does).
