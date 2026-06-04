# Hyperia™

**A terminal emulator built for agents and humans.**

![Hyperia](hyperia.png)

Hyperia is an agent-native terminal emulator. Forked from [Hyper](https://github.com/vercel/hyper) and extended with a Rust sidecar, it turns the terminal into a first-class platform for AI orchestration. Agents connect over the Model Context Protocol (MCP) and operate terminal sessions as peers — opening tabs, splitting panes, running commands, reading screens, and reporting status — while the human stays in control at all times.

Built by [Deep Blue Dynamics](https://deepbluedynamics.com).

---

## Highlights

- **Agent-native MCP server** — 50+ tools exposed over streamable HTTP. Any MCP-capable client (Claude Code, OpenAI Codex, Google Antigravity, and others) can drive the terminal: open tabs, split panes, run commands, read screens, manage sticky notes, and inspect telemetry.
- **Ghost agent** — A built-in assistant with streaming chat, tool use, and persistent memory. It is aware of what is open, what is running, and what it has done before.
- **Ferricula memory** — An embedded memory engine. Memories persist, decay, and connect across sessions, backed by BM25 search and a semantic graph.
- **Per-tab agent status** — Live indicators show which tabs have an agent connected, working, or idle.
- **Stickys™** — Floating, named, color-coded notes that persist across restarts and are fully controllable from any agent.
- **Shell profiles** — PowerShell, CMD, WSL, Git Bash, or any custom shell, surfaced in the new-pane chooser.
- **Sidecar architecture** — A dedicated Rust process (`hyperia-sidecar`) provides the HTTP, WebSocket, and MCP surfaces, decoupled from Electron for speed and reliability.
- **Telemetry dashboard** — Per-pane metrics at `http://localhost:9800/dashboard`.

---

## Quick start

```bash
git clone https://github.com/DeepBlueDynamics/hyperia.git
cd hyperia
yarn install

cd sidecar && cargo build && cd ..

yarn run dev
```

See [docs/getting-started.md](docs/getting-started.md) for prerequisites and full build instructions. Prebuilt, signed installers for Windows and macOS are available on the [Releases](https://github.com/DeepBlueDynamics/hyperia/releases) page.

---

## Connect an agent (MCP over HTTP)

While Hyperia is running, the sidecar exposes its MCP server over **streamable HTTP**:

```
http://localhost:9800/mcp
```

No API key or local binary path is required — point any MCP client at that URL. (The port is `9800` by default; override it with `HYPERIA_PORT`.) The examples below assume Hyperia is running on the same machine as the client.

### Claude Code

Register the server with the CLI:

```bash
claude mcp add --transport http hyperia http://localhost:9800/mcp
```

Add `--scope user` to make it available across all projects. To configure it per-project instead, commit a `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "hyperia": {
      "type": "http",
      "url": "http://localhost:9800/mcp"
    }
  }
}
```

Verify with `claude mcp list` or `/mcp` inside a session.

### OpenAI Codex

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.hyperia]
url = "http://localhost:9800/mcp"
```

Codex discovers the tools on its next launch. Confirm with `codex mcp list`.

### Google Antigravity

Open the MCP settings (**Settings → MCP → Add Server**), or edit Antigravity's MCP configuration file directly:

```json
{
  "mcpServers": {
    "hyperia": {
      "serverUrl": "http://localhost:9800/mcp"
    }
  }
}
```

Reload the MCP servers from the settings panel; Hyperia's tools then appear in the agent's tool list.

### Other clients

Any client that supports the MCP streamable-HTTP transport works the same way — register the URL `http://localhost:9800/mcp`. The full tool catalog is documented in [docs/mcp-tools.md](docs/mcp-tools.md).

---

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Install, build, and first launch |
| [MCP Tools](docs/mcp-tools.md) | Complete tool reference |
| [Ghost Agent](docs/ghost-agent.md) | Built-in assistant — models, memory, behavior |
| [Configuration](docs/configuration.md) | Config file reference and keyboard shortcuts |
| [Ferricula Memory](docs/ferricula.md) | Memory engine, recall, and identity |
| [Architecture](docs/architecture.md) | Codebase structure and component overview |
| [Building](docs/building.md) | Release builds — Windows (Azure Trusted Signing) and macOS |
| [Apple Signing](docs/signing-apple.md) | macOS code signing and notarization |

---

## Architecture

```
Electron (UI + PTY sessions)
    │
    │── WebSocket bridge ──▶ hyperia-sidecar (Rust, :9800)
                                  │
                                  ├── HTTP API (terminal, agent, notes, telemetry)
                                  ├── MCP server (streamable HTTP at /mcp, 50+ tools)
                                  ├── Ghost agent (streaming, tool loop)
                                  ├── Ferricula core (embedded memory engine)
                                  │     ├── Identity and keypair
                                  │     ├── Durable store (~/.hyperia/memory/)
                                  │     └── BM25 search + semantic graph
                                  └── Telemetry + dashboard
```

---

## License

MIT — see [LICENSE](LICENSE).

Based on [Hyper](https://github.com/vercel/hyper) by Vercel.
