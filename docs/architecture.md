# Architecture

Hyperia is an Electron front end paired with a Rust sidecar. Electron owns the UI and the PTY sessions; the sidecar owns the HTTP/WebSocket/MCP surfaces, the built-in agent, local search, and telemetry.

## Overview

```
Electron (UI + PTY sessions, sticky windows, web panes)
    │
    │── WebSocket bridge ──▶ hyperia-sidecar (Rust, :9800)
                                  │
                                  ├── HTTP API (terminal, notes, telemetry, ghost, fsnav)
                                  ├── MCP server — streamable HTTP at /mcp (72 tools)
                                  ├── Built-in agent harness (streaming, tool loop, multi-provider)
                                  │     ├── provider: anthropic / openai / gemini / ollama
                                  │     ├── compressor (Maximus — Ollama output filtering)
                                  │     └── ferricula client (OPTIONAL external recall)
                                  ├── lume — local BM25 over shell logs + notes (~/.hyperia/lume/)
                                  └── telemetry + dashboard (:9800/dashboard)
```

## Electron app (`app/`)

Fork of [Hyper](https://github.com/vercel/hyper): React + Redux UI with xterm.js rendering. The renderer bundle lives in `lib/`.

| File | Responsibility |
|------|---------------|
| `app/index.ts` | Main process: window creation, sidecar spawn, splash (once per version) |
| `app/bridge.ts` | WebSocket bridge to the sidecar; relays PTY data and commands |
| `app/sticky.ts` | Floating sticky-note windows, including file-linked code notes |
| `app/config/` | Config load + shell-profile detection (`detect.ts`) |
| `lib/components/term.tsx` | Terminal pane + the new-pane Chooser / profile picker |
| `lib/components/web-pane.tsx` | Embedded `<webview>` web panes |

## Sidecar (`sidecar/src/`)

Rust process (`hyperia-sidecar`) started by the Electron app on port `9800`.

| Module | Responsibility |
|--------|---------------|
| `main.rs` | Axum HTTP server, route registration, app state; mounts the MCP service at `/mcp` |
| `bridge.rs` | WebSocket connection to Electron, command dispatch |
| `mcp.rs` | MCP server (rmcp) exposing 72 tools over **streamable HTTP** |
| `lume_store.rs` | Local BM25 index over per-shell logs + sticky notes |
| `screen.rs` / `snapshot_image.rs` | Terminal screen reads + screenshot/PNG capture |
| `telemetry.rs` / `dashboard.rs` | Per-pane metrics + dashboard routes |
| `fsnav.rs` | Filesystem navigation endpoints |
| `process.rs` / `logs.rs` / `chat.rs` | Process info, rolling logs, chat plumbing |
| `ghost/agent.rs` | Ghost agent run loop, tool execution, stop/window-close signals |
| `ghost/provider.rs` | Multi-provider streaming client (anthropic/openai/gemini/ollama) |
| `ghost/registry.rs` | Ghost tool definitions + execution (builtins, dynamic tools) |
| `ghost/compressor.rs` | Maximus — Ollama-based output filtering / context compression |
| `ghost/ferricula.rs` | **Optional** external memory recall (HTTP client; no-op when unreachable) |
| `ghost/api.rs` / `ghost/types.rs` | Ghost HTTP routes and shared types |

> Note: Ferricula is an HTTP client to an external service, **not** an embedded crate — the sidecar builds without it (`sidecar/Cargo.toml`). The built-in, default memory is `lume`. See [memory.md](memory.md).

## Transports

Agents reach Hyperia two ways:

- **MCP over streamable HTTP** — `http://localhost:9800/mcp` (Claude Code, Codex, Antigravity, any MCP client). This is the primary integration surface; see [mcp-tools.md](mcp-tools.md).
- **HTTP API directly** — `http://localhost:9800/api/*` for custom integrations.

A terminal command flows: `MCP tool call → sidecar → bridge → Electron renderer → PTY`, and results return the same path. Screen reads return the current vt100-rendered state.

## Notes persistence

Sticky notes are stored under `~/.hyperia/stickys/`. The sidecar reads/writes note data; Electron is notified over the bridge to manage the note BrowserWindow lifecycle (create/close/delete/update). Note content is also indexed by `lume` for `sticky_note_search`.
