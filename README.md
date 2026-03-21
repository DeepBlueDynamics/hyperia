# Hyperia

**The shell that remembers everything — and acts on it.**

![Hyperia](hyperia.png)

Hyperia is a terminal emulator built for agents and humans. Forked from [Hyper](https://github.com/vercel/hyper) and extended with a Rust sidecar, it turns the terminal into a first-class platform for AI orchestration. Agents connect via MCP or HTTP/WebSocket and operate terminals as peers — typing, reading screens, splitting panes, and signaling status — while humans stay in control.

Built by [Deep Blue Dynamics](https://deepbluedynamics.com).

---

## What makes it different

- **Agent-native** — AI agents connect through the sidecar and drive terminal sessions alongside you. A per-session queue defers agent input while you're actively typing.
- **MCP server** — 30+ tools for Claude Code, Gemini, Codex, or any MCP client. Open tabs, split panes, run commands, read screens, set status lights, control Stream Deck hardware.
- **Per-tab agent status** — Live indicators show which tabs have agents connected, working, or idle. No global status bar — each session tracks its own agent.
- **Shell profiles** — PowerShell, CMD, WSL, Claude, Nemesis8, or any custom shell. New-tab dropdown shows available profiles.
- **Visual themes** — Switch between Ember, Phosphor, Signal, Archive, and Prism from the View menu. Live switch, no restart.
- **Sidecar architecture** — Rust process (`hyperia-sidecar`) with HTTP + WebSocket API. Decoupled from the Electron shell for speed and reliability.
- **Stream Deck Plus** — Buttons, rotary encoders, and touchstrip as a physical control surface for terminal operations.
- **Voice integration** — Auracle mic/voice capture with transcript forwarding to active panes.
- **Telemetry dashboard** — Per-pane metrics for file ops, network, and token usage.

---

## Quick start

```bash
# Clone and install
git clone https://github.com/DeepBlueDynamics/hyperia.git
cd hyperia
yarn install

# Build the sidecar (requires Rust)
cd sidecar
cargo build
cd ..

# Run in dev mode
yarn run dev
```

The sidecar starts automatically with the Electron app.

### Packaged build (Windows)

```bash
yarn build
npx electron-builder --win --x64 --dir
# Output: dist/win-unpacked/Hyperia.exe
```

### MCP server for Claude Code

Add to your project's `.mcp.json`:
```json
{
  "mcpServers": {
    "hyperia": {
      "command": "path/to/hyperia-sidecar",
      "args": ["--mcp"]
    }
  }
}
```

---

## MCP tools

| Tool | Description |
|------|-------------|
| `terminal_keys` | Type keystrokes into a pane (`\n` for Enter, `\t` for Tab) |
| `terminal_run` | Run a command, wait, return screen output |
| `terminal_screen` | Read current screen content |
| `terminal_status` | List all open panes with IDs, dimensions, PIDs |
| `terminal_split` | Split the focused pane (horizontal/vertical) |
| `terminal_focus` | Focus a specific pane by index |
| `terminal_close` | Close the focused pane |
| `terminal_new_tab` | Open a new tab with optional startup command |
| `tab_snapshot` | Read all pane screens at once |
| `shell_state` | Detect pane state (idle, dialog, running, empty) |
| `shell_confirm` | Auto-handle common prompts (trust dialogs, y/n) |
| `agent_status` | Set status light (connected, working, label, human %) |
| `sidecar_logs` | Read sidecar log output |
| `voice_status` | Get Auracle voice/mic status |
| `voice_start` / `voice_stop` / `voice_toggle` | Control voice capture |
| `style_list` / `style_create` / `style_delete` | Manage visual themes |
| `telemetry_toggle` / `telemetry_snapshot` / `telemetry_record` / `telemetry_reset` | Telemetry controls |
| `dashboard_widgets` | Configure dashboard widget layout |
| `deck_info` / `deck_button_image` / `deck_button_color` / `deck_touchstrip` / `deck_brightness` / `deck_knob` / `deck_screenshot` | Stream Deck Plus controls |

---

## Configuration

User config: `~/.hyperia/hyperia.json`

```json
{
  "config": {
    "fontSize": 16,
    "fontFamily": "Menlo, Consolas, monospace",
    "backgroundColor": "#000",
    "foregroundColor": "#fff",
    "shell": "",
    "shellArgs": ["--login"],
    "defaultProfile": "PowerShell",
    "profiles": [
      { "name": "PowerShell", "config": { "shell": "pwsh.exe" } },
      { "name": "Ember", "config": { "backgroundColor": "#1A1410", "foregroundColor": "#E8DCC8" } }
    ]
  }
}
```

Profiles with `shell` set appear in the new-tab dropdown. Profiles without `shell` (colors only) appear in View > Theme.

---

## Architecture

```
Electron (UI + PTY sessions)
    │
    │── WebSocket bridge ──▶ hyperia-sidecar (Rust, :9800)
                                  │
                                  ├── HTTP API (terminal, agent, voice, telemetry)
                                  ├── MCP server (stdio, 30+ tools)
                                  ├── Stream Deck Plus (:9850)
                                  ├── Auracle voice engine
                                  └── Dashboard + telemetry store
```

The bridge streams PTY data to the sidecar and relays commands back. Agents never touch the PTY directly.

---

## License

MIT — see [LICENSE](LICENSE)

Based on [Hyper](https://github.com/vercel/hyper) by Vercel.
