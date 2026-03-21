# Hyperia

**A terminal built for agents and humans.**

<!-- TODO: drop hero image in assets/ and uncomment -->
<!-- ![Hyperia](assets/hero.png) -->

Hyperia is a modern terminal emulator forked from [Hyper](https://github.com/vercel/hyper), extended with a Rust sidecar that turns it into a first-class platform for AI agents. Agents connect via MCP or the HTTP/WebSocket API and operate terminals as peers — typing, reading screens, splitting panes, and signaling status — while humans stay in control.

---

## What makes it different

- **Agent-native** — AI agents connect through the sidecar and drive terminal sessions alongside you. A per-session queue defers agent input while you're actively typing.
- **MCP server built in** — Claude Code, or any MCP-compatible client, can open tabs, split panes, run commands, read screens, and toggle the status light out of the box.
- **Status bar** — A live indicator shows whether an agent is connected and the human interaction percentage, so you always know who's driving.
- **Sidecar architecture** — A Rust process (`hyperia-sidecar`) exposes a local HTTP + WebSocket API. The Electron shell and the sidecar communicate over a bridge, keeping the agent layer decoupled and fast.
- **Styles** — Whole-window visual styles you can create, clone, and delete via MCP or the config file.
- **Dynamic window title** — The taskbar shows the active session title and a letter icon, not a generic "H".
- **Stream Deck support** — Optional integration for hardware control surfaces.
- **Cross-platform** — Windows, macOS, Linux.

---

## Quick start

```bash
# Clone and install
git clone https://github.com/anthropics/hyperia.git
cd hyperia
yarn install

# Build the sidecar
cd sidecar
cargo build
cd ..

# Run in dev mode
yarn run dev
```

The sidecar starts automatically with the Electron app.

---

## MCP tools

When connected as an MCP server, Hyperia exposes:

| Tool | Description |
|------|-------------|
| `terminal_keys` | Type keystrokes into a pane |
| `terminal_run` | Run a command and return screen output |
| `terminal_screen` | Read current screen content |
| `terminal_status` | List all open panes |
| `terminal_split` | Split the focused pane |
| `terminal_focus` | Focus a specific pane |
| `terminal_close` | Close the focused pane |
| `terminal_new_tab` | Open a new tab |
| `agent_status` | Set the status light (connected, label, human %) |
| `style_list` | List available styles |
| `style_create` | Create or clone a style |
| `style_delete` | Delete a style |
| `sidecar_logs` | Read sidecar log output |

---

## Configuration

User config lives at `~/.hyperia/hyperia.json` (Windows: `%USERPROFILE%\.hyperia\hyperia.json`).

Key settings: `fontSize`, `fontFamily`, `backgroundColor`, `foregroundColor`, `cursorColor`, `colors`, `shell`, `shellArgs`.

Styles are stored in the `config.styles` array and apply per-window.

---

## Architecture

```
Electron (UI + PTY sessions)
    |
    |--- WebSocket bridge ---> hyperia-sidecar (Rust)
                                    |
                                    |--- HTTP API (localhost:9800)
                                    |--- MCP server (stdio)
                                    |--- Stream Deck (optional)
```

The bridge streams PTY output to the sidecar and relays commands (keystrokes, splits, focus, status) back to Electron. Agents never touch the PTY directly.

---

## License

MIT -- see [LICENSE](LICENSE)

Based on [Hyper](https://github.com/vercel/hyper) by Vercel.
Copyright (c) 2018 Vercel, Inc.
