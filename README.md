# Hyperia™

**She's a ghost in your shell.**

![Hyperia](hyperia.png)

Hyperia is a terminal emulator built for agents and humans. Forked from [Hyper](https://github.com/vercel/hyper) and extended with a Rust sidecar, it turns the terminal into a first-class platform for AI orchestration. Agents connect via MCP or HTTP/WebSocket and operate terminal sessions as peers — typing, reading screens, splitting panes, and signaling status — while humans stay in control.

Built by [Deep Blue Dynamics](https://deepbluedynamics.com).

---

## What makes it different

- **Ghost agent** — Built-in AI (Ask Hyperia, right-click menu) with streaming chat, tool use, and Ferricula memory. She knows what's open, what's running, and what she's done before.
- **Ferricula memory** — Embedded thermodynamic memory core. Identity blessed on first launch via I Ching hexagram casting. Memories persist, decay, dream, and connect across sessions.
- **Agent-native MCP** — 30+ tools for Claude Code, Gemini, Codex, or any MCP client. Open tabs, split panes, run commands, read screens, set status lights, manage notes, inspect telemetry.
- **Per-tab agent status** — Live indicators show which tabs have agents connected, working, or idle.
- **Stickys™** — Floating sticky notes with names, colors, persistence. Create and manage them from the agent or right-click menu. Survive restarts.
- **Shell profiles** — PowerShell, CMD, WSL, Claude, or any custom shell. New-tab dropdown shows available profiles.
- **Sidecar architecture** — Rust process (`hyperia-sidecar`) with HTTP + WebSocket API. Decoupled from Electron for speed and reliability.
- **Telemetry dashboard** — Per-pane metrics at `localhost:9800/dashboard`.

---

## Quick start

```bash
git clone https://github.com/DeepBlueDynamics/hyperia.git
cd hyperia
yarn install

cd sidecar && cargo build && cd ..

yarn run dev
```

See [docs/getting-started.md](docs/getting-started.md) for full prerequisites and build instructions.

---

## MCP server

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "hyperia": {
      "command": "path/to/hyperia-sidecar.exe",
      "args": ["--mcp"]
    }
  }
}
```

Full tool reference: [docs/mcp-tools.md](docs/mcp-tools.md)

---

## Documentation

| Doc | Description |
|-----|-------------|
| [Getting Started](docs/getting-started.md) | Install, build, first launch |
| [MCP Tools](docs/mcp-tools.md) | All 30+ tools with descriptions |
| [Ghost Agent](docs/ghost-agent.md) | Built-in AI — models, memory, behavior |
| [Configuration](docs/configuration.md) | Config file reference, keyboard shortcuts |
| [Ferricula Memory](docs/ferricula.md) | Memory engine, recall, identity |
| [Architecture](docs/architecture.md) | Codebase structure, component overview |
| [Building](BUILDING.md) | Release build + signing (Windows) |

---

## Architecture

```
Electron (UI + PTY sessions)
    │
    │── WebSocket bridge ──▶ hyperia-sidecar (Rust, :9800)
                                  │
                                  ├── HTTP API (terminal, agent, notes, telemetry, ghost)
                                  ├── MCP server (stdio, 30+ tools)
                                  ├── Ghost agent (streaming, tool loop, stop flag)
                                  ├── Ferricula core (embedded memory engine)
                                  │     ├── Identity (I Ching, archetypes, ECC keypair)
                                  │     ├── DurableEngine (~/.hyperia/memory/)
                                  │     └── BM25 search + semantic graph
                                  └── Telemetry + dashboard
```

---

## License

MIT — see [LICENSE](LICENSE)

Based on [Hyper](https://github.com/vercel/hyper) by Vercel.
