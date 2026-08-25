# Developing Hyperia

Hyperia is an Electron terminal emulator paired with a Rust sidecar. This guide covers building from source, first launch, and connecting an agent.

Prebuilt, signed installers for Windows and macOS are on the [Releases](https://github.com/DeepBlueDynamics/hyperia/releases) page — if you only want to *run* Hyperia, use those. The steps below build from source.

## Prerequisites

**All platforms:**
- **Node.js 22+** (the build toolchain requires ≥ 22.12)
- **Yarn** (`npm install -g yarn`)
- **Rust** stable (via [rustup](https://rustup.rs))

**Windows:** Visual Studio Build Tools with the C++ workload.
**macOS:** `xcode-select --install`.
**Linux (Debian/Ubuntu):** `sudo apt install build-essential libx11-dev libxkbfile-dev python3`

Hyperia has **no source dependency that must be cloned alongside it** — `yarn install` and `cargo build` pull everything they need.

## Build and run

```bash
git clone https://github.com/DeepBlueDynamics/hyperia.git
cd hyperia

# JS/TS dependencies
yarn install

# Rust sidecar
cd sidecar && cargo build && cd ..

# Run in development (webpack + tsc watchers + the Electron app, with reload)
yarn start
```

`yarn start` launches Hyperia and reloads on change. The Electron app spawns the sidecar automatically as a child process on port `9800` — you do not start it yourself.

For production/release builds (installers, code signing, nightly), see [building.md](building.md).

## First launch

On first run Hyperia casts a one-time splash, then opens a terminal. The built-in agent harness ("Ask Hyperia" / right-click menu) needs a provider configured to be useful:

- **Frontier** — set an API key for `anthropic` (or `openai` / `gemini`) under `providers` in `~/.hyperia/hyperia.json`, and an `agent.provider` / `agent.model`.
- **Local** — point it at a local Ollama; with nothing else configured it falls back to local Ollama (`gemma2:9b`).

See [configuration.md](configuration.md) for the full config shape and [ghost-agent.md](ghost-agent.md) for the built-in agent.

## Connect an agent (MCP over HTTP)

While Hyperia is running, the sidecar exposes its MCP server over **streamable HTTP** at `${HYPERIA_MCP_URL:-http://localhost:9800/mcp}`.

Read operations work anonymously, while write/mutation operations require `HYPERIA_AGENT_TOKEN` (automatically injected inside Hyperia terminal panes). For client setup (Claude Code, OpenAI Codex, Grok, Google Antigravity), run `hyperia mcp` or see the [README](../README.md#connect-an-agent-mcp-over-http). The full catalog of tools is documented in [mcp-tools.md](mcp-tools.md).

## Where things live

| Path | What |
|------|------|
| `~/.hyperia/hyperia.json` | Configuration (providers, profiles) |
| `~/.hyperia/lume/` | Local search index (shell history + notes) |
| `~/.hyperia/stickys/` | Sticky-note storage |
| `app/` | Electron main process |
| `lib/` | Renderer (React + xterm.js) |
| `sidecar/` | Rust sidecar (HTTP / WebSocket / MCP) |
