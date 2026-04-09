# Architecture

## Overview

```
Electron (UI + PTY sessions)
    │
    │── WebSocket bridge ──▶ hyperia-sidecar (Rust, :9800)
                                  │
                                  ├── HTTP API  (terminal, agent, notes, telemetry, ghost)
                                  ├── MCP server (stdio, 30+ tools)
                                  ├── Ghost agent (streaming, tool loop, Ferricula recall)
                                  ├── Ferricula core (embedded memory engine)
                                  │     ├── Identity (I Ching, archetypes, ECC keypair)
                                  │     ├── DurableEngine (~/.hyperia/memory/)
                                  │     └── BM25 search + semantic graph
                                  └── Telemetry + dashboard (:9800/dashboard)
```

## Components

### Electron app (`app/`)

- Fork of [Hyper](https://github.com/vercel/hyper)
- React + Redux UI with xterm.js terminal rendering
- `bridge.ts` — WebSocket bridge to sidecar; relays PTY data and commands
- `ghost.ts` — Ghost chat window (BrowserWindow with streaming chat UI)
- `sticky.ts` — Floating sticky note windows (Stickys™)
- `settings.ts` — Settings panel with token, model selector, factory reset

### Sidecar (`sidecar/src/`)

Rust process (`hyperia-sidecar.exe`) that starts with the app.

| Module | Responsibility |
|--------|---------------|
| `main.rs` | Axum HTTP server, route registration, app state |
| `bridge.rs` | WebSocket connection to Electron, command dispatch |
| `ghost/agent.rs` | Ghost agent run loop, tool execution, stop/window-close signals |
| `ghost/provider.rs` | Anthropic Messages API streaming client with retry |
| `ghost/registry.rs` | Tool definitions + execution (builtins, dynamic, memory) |
| `ghost/ferricula.rs` | Ferricula recall integration (3-stage hybrid search) |
| `ghost/types.rs` | Shared types (GhostConfig, ProviderEvent, ToolDef) |
| `mcp.rs` | MCP stdio server (rmcp) — exposes sidecar tools to external agents |
| `telemetry.rs` | Per-pane metrics collection |
| `dashboard.rs` | Dashboard HTTP routes |
| `screen.rs` | Screenshot capture + PNG encoding |

### Ferricula (`../../ferricula/`)

External crate, path-linked. Provides:
- `DurableEngine` — persistent SQLite-backed memory store
- `MemoryRecord` — with BM25 index, importance, keystone, emotion
- `SearchHit` — with `bm25_score: f64` and `probability: f64`
- Identity casting, archetype activation, memory dreaming

## Agent protocol

Agents connect to Hyperia either via:
- **MCP stdio** — `hyperia-sidecar --mcp` (for Claude Code, Codex, Gemini)
- **HTTP directly** — `localhost:9800/api/*` (for custom integrations)

Terminal commands flow: `agent tool call → sidecar → bridge → Electron renderer → PTY`

Results flow back the same path. Screen reads happen via `/api/screen` which returns the current vt100-rendered terminal state.

## Notes persistence

Sticky notes are stored at `~/.hyperia/stickys/notes.json` as a JSON array. The sidecar reads/writes this file directly for API calls. Electron is notified via bridge commands (`NoteCreate`, `NoteClose`, `NoteDelete`, `NoteUpdate`) to manage the BrowserWindow lifecycle.
