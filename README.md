# Hyperia™

**She's a ghost in your shell.**

![Hyperia](hyperia.png)

Hyperia is a terminal emulator built for agents and humans. Forked from [Hyper](https://github.com/vercel/hyper) and extended with a Rust sidecar, it turns the terminal into a first-class platform for AI orchestration. Agents connect via MCP or HTTP/WebSocket and operate terminal sessions as peers — typing, reading screens, splitting panes, and signaling status — while humans stay in control.

Built by [Deep Blue Dynamics](https://deepbluedynamics.com).

---

## What makes it different

- **Hyperia agent** — A built-in AI agent (Ask Hyperia, right-click menu) with streaming chat, tool use, and Ferricula memory. She knows what's open, what's running, and what she's done before.
- **Ferricula memory** — Embedded thermodynamic memory core. Identity blessed on first launch via I Ching hexagram casting. Memories persist, decay, dream, and connect across sessions.
- **Agent-native MCP** — 30+ tools for Claude Code, Gemini, Codex, or any MCP client. Open tabs, split panes, run commands, read screens, set status lights, inspect telemetry, and manage memory.
- **Per-tab agent status** — Live indicators show which tabs have agents connected, working, or idle. Each session tracks its own agent.
- **Stickys™** — Floating sticky notes with names, colors, persistence, and cross-linking. Right-click to change color, copy, rename, or delete. Notes survive restarts.
- **Shell profiles** — PowerShell, CMD, WSL, Claude, or any custom shell. New-tab dropdown shows available profiles.
- **Sidecar architecture** — Rust process (`hyperia-sidecar`) with HTTP + WebSocket API. Decoupled from Electron for speed and reliability. Ferricula runs embedded inside it.
- **Telemetry dashboard** — Per-pane metrics for file ops, network, and token usage at `localhost:9800/dashboard`.

---

## Quick start

```bash
# Clone and install
git clone https://github.com/DeepBlueDynamics/hyperia.git
cd hyperia
yarn install

# Build the sidecar (requires Rust)
# Note: sidecar has a path dependency on Ferricula — clone it alongside:
# C:/Code/Gnosis/ferricula/ferricula  (or update sidecar/Cargo.toml path)
cd sidecar
cargo build
cd ..

# Run in dev mode
yarn run dev
```

The sidecar starts automatically with the Electron app.

### Packaged builds

**Windows:**
```bash
yarn build
npx electron-builder --win --x64
# Output: dist/Hyperia-0.5.x-x64.exe
```

**macOS:**
```bash
yarn build
npx electron-builder --mac
# Output: dist/Hyperia-0.5.x-mac-arm64.dmg
#         dist/Hyperia-0.5.x-mac-x64.dmg
```

**Linux:**
```bash
yarn build
npx electron-builder --linux
# Output: dist/Hyperia-0.5.x.AppImage, .deb, .rpm
```

### Prerequisites

**All platforms:**
```bash
# Node.js (>= 18) + Yarn
npm install -g yarn

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Windows:** [Node.js](https://nodejs.org), [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload), [Rust](https://rustup.rs)

**macOS:** `xcode-select --install`, then Node + Yarn

**Linux (Debian/Ubuntu):**
```bash
sudo apt install build-essential libx11-dev libxkbfile-dev python3
```

---

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

### Terminal control

| Tool | Description |
|------|-------------|
| `terminal_keys` | Type keystrokes (`\n` Enter, `\t` Tab, `ctrl+c`, `\x1b` Esc) |
| `terminal_run` | Run a command, wait, return screen output |
| `terminal_screen` | Read current screen content of a pane |
| `terminal_status` | List all windows/tabs/panes with IDs, dimensions, PIDs |
| `terminal_split` | Split the focused pane (horizontal/vertical) |
| `terminal_focus` | Focus a pane by window/tab/pane address |
| `terminal_close` | Close the focused pane |
| `terminal_new_tab` | Open a new tab with optional startup command |
| `terminal_rename` | Rename a tab |
| `tab_snapshot` | Read all pane screens at once |
| `shell_state` | Detect pane state (idle, dialog, running, empty) |
| `shell_confirm` | Auto-handle common prompts (trust dialogs, y/n) |

### Agent

| Tool | Description |
|------|-------------|
| `agent_status` | Set status light (connected, working, label, human %) |
| `auto_describe` | Use local Ollama to describe what a pane is doing |
| `watercooler` | Pause and check in with the human mid-task |

### Memory (Ferricula)

| Tool | Description |
|------|-------------|
| `memory_recall` | Search memory by query (BM25 text search) |
| `memory_remember` | Store a memory with importance, emotion, keystone flag |
| `memory_dream` | Trigger memory consolidation and archetype activation |
| `memory_connect` | Create a semantic edge between two memories |
| `memory_status` | View identity, hexagram, heat, memory count |

### Meta-tools

| Tool | Description |
|------|-------------|
| `tool_search` | Find available tools by keyword |
| `tool_create` | Create a new shell-command-backed tool at runtime |

### Observability

| Tool | Description |
|------|-------------|
| `sidecar_logs` | Read sidecar log output |
| `hyperia_version` | Get sidecar + Electron app versions |
| `telemetry_toggle` / `telemetry_snapshot` / `telemetry_record` / `telemetry_reset` | Per-pane telemetry |
| `dashboard_widgets` | Configure dashboard widget layout |
| `style_list` / `style_create` / `style_delete` | Manage visual themes |

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
    "agentToken": "your-anthropic-api-key",
    "agentModel": "anthropic",
    "ferricula": {
      "mode": "local",
      "url": "http://localhost:8765"
    },
    "profiles": [
      { "name": "PowerShell", "config": { "shell": "pwsh.exe" } },
      { "name": "Claude", "config": { "shell": "cmd.exe", "shellArgs": ["/c", "claude"] } }
    ]
  }
}
```

**Ferricula modes:** `local` (embedded, default), `remote` (HTTP to Docker instance), `both`

**Agent token:** Set via Settings (Ctrl+,) — no restart required. Supports Anthropic, OpenAI, Google, OpenRouter.

---

## Architecture

```
Electron (UI + PTY sessions)
    │
    │── WebSocket bridge ──▶ hyperia-sidecar (Rust, :9800)
                                  │
                                  ├── HTTP API (terminal, agent, telemetry, ghost)
                                  ├── MCP server (stdio, 30+ tools)
                                  ├── Ghost agent (streaming, tool loop, stop flag)
                                  ├── Ferricula core (embedded memory engine)
                                  │     ├── Identity (I Ching, archetypes, ECC keypair)
                                  │     ├── DurableEngine (~/.hyperia/memory/)
                                  │     └── BM25 search + semantic graph
                                  └── Telemetry + dashboard
```

The bridge streams PTY data to the sidecar and relays commands back. Agents never touch the PTY directly.

---

## License

MIT — see [LICENSE](LICENSE)

Based on [Hyper](https://github.com/vercel/hyper) by Vercel.
