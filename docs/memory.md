# Memory & Search

Hyperia has two distinct memory layers. Know which is which.

## lume — built-in local memory (default, zero-config)

**lume** is the memory that ships and works out of the box. It lives in the sidecar (`sidecar/src/lume_store.rs`, the `lume` crate at `../lume`) and maintains a **local BM25 index** over:

- **Per-shell terminal logs** — output captured from each pane, keyed by shell uid.
- **Sticky notes** — note content, read fresh from storage.

It persists to `~/.hyperia/lume/` and requires no setup, no network, and no external service. It is surfaced to agents through two MCP tools:

| Tool | Searches |
|------|----------|
| `shell_log_search` | Per-shell terminal history (optionally scoped to one shell uid) |
| `sticky_note_search` | Sticky-note content |

This is what lets an agent search *what you actually ran and wrote*, not just the handful of lines still on screen.

## Ferricula — optional external memory service

**Ferricula** (`sidecar/src/ghost/ferricula.rs`) is an **optional** memory backend for the built-in **Ghost** agent's cross-session recall. Important properties:

- It is an **HTTP client**, not embedded code. There is **no Ferricula crate dependency** — the sidecar builds and runs without it.
- It talks to an external service over HTTP, resolved in order: the `FERRICULA_URL` env var, then a configured URL, then the default `http://localhost:8765`. You run that service yourself (locally via Docker, or point at a remote instance).
- If the service is **unreachable, all calls degrade gracefully to no-ops** — recall simply returns nothing. So if you haven't set Ferricula up, the Ghost agent still works; it just has no long-term recall layer.

Ferricula is not required for Hyperia, lume, or the MCP tools. It is an add-on for users who want persistent, cross-session agent memory and are willing to run the backing service.

## Summary

| | lume | Ferricula |
|---|------|-----------|
| Role | Local search over shell history + notes | Cross-session recall for the Ghost agent |
| Where | In-process, in the sidecar | External HTTP service you run |
| Default | On, zero-config | Off (no-op unless reachable) |
| Storage | `~/.hyperia/lume/` | The external service |
| Surfaced as | `shell_log_search`, `sticky_note_search` | Internal to the Ghost agent |
