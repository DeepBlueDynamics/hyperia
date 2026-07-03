# Tool Doors — progressive disclosure for Hyperia's tool catalog

Hyperia exposes 100+ agent tools. Showing all of them to a model on every turn is
expensive: a 4B local model (Sailfish, ~8k context) drowns in the schema, and a
token-billed cloud model pays for a giant `tools` array it mostly ignores. **Doors**
are the fix — a progressive-disclosure model where a model only ever sees a small
**core** plus a bounded set of **open doors**.

A **door** is a named category of tools (`web`, `stickys`, `terminal_layout`, …).
The menu of *closed* doors costs one line each (name + one-line description). A model
opens a door to reveal its tools, and the door's full schemas land in the next
`tools` list.

> **Doors are NOT a security boundary.** The door menu is purely a UX / token-budget
> concern. Consent (`request_access`, the 202/403 soft-walls) and identity (the
> `hyp_agent_` token) are enforced at the HTTP API layer, never by doors. That is why
> auto-opening a door on a direct tool call (below) is safe by construction — it
> grants nothing the menu was merely hiding.

The pure data layer (the taxonomy + `DoorState` bookkeeping) lives in
[`sidecar/src/doors.rs`](../sidecar/src/doors.rs) and is exhaustively unit-tested
(`cargo test -- doors::`).

## Two surfaces, one taxonomy

Doors are applied independently on the two tool surfaces Hyperia ships:

| Surface | Where | Consumer | Default |
| --- | --- | --- | --- |
| **Ghost** | `sidecar/src/ghost/*` | Hyperia's built-in agent loop | `auto` (on) |
| **MCP** | `sidecar/src/mcp.rs` | External MCP clients (Claude Code, other CLIs) over stdio / streamable-HTTP | **off** (full catalog) |

Both share the *concept* of doors but expose different tool sets and, in places,
different door names (ghost `terminal` vs. MCP `terminal_layout`). Each [`Door`]
carries both a `ghost_tools` and an `mcp_tools` slice; a door absent from a surface
leaves that slice empty. The taxonomy is a **partition** per surface — every tool is
in exactly one door *or* the always-on core, never both, never two doors (enforced by
unit tests).

### Core (always on)

- **Ghost core (11):** `terminal_status`, `terminal_run`, `terminal_screen`,
  `file_read`, `file_write`, `watercooler`, `memory_recall`, `memory_remember`, plus
  meta `tool_search` / `open_tools` / `close_tools`.
- **MCP core (12):** `terminal_status`, `terminal_run`, `terminal_screen`,
  `terminal_keys`, `terminal_split`, `tab_snapshot`, `request_access`,
  `request_token`, `hyperia_version`, plus meta `open_tools` / `close_tools` /
  `search_tools`.

## Configuration

### Ghost — `config.agent.tool_doors`

`"off" | "on" | "auto"` (default `auto`). `auto` turns doors **on** for every
provider: small/local models get the tight cap ([`DEFAULT_TOOL_CAP`] = 20), cloud
models get [`CLOUD_TOOL_CAP`] = 24. Resolved by `doors::resolve_door_config`.

### MCP — `config.agent.mcp_tool_doors`

`"on" | "off"` (default **off**). This is deliberately **opt-in**: external agents
were built against the full 67-tool MCP catalog, so they keep it unless the user
explicitly turns doors on. Only an explicit `on` / `true` / `1` enables — `off`,
`auto`, `""`, and any unknown value all stay off. When on, doors apply with
[`CLOUD_TOOL_CAP`] = 24 headroom (external MCP clients are typically cloud/large
models). Resolved by `doors::resolve_mcp_door_config`.

### Environment overrides (both surfaces)

| Var | Effect |
| --- | --- |
| `HYPERIA_TOOL_DOORS=1` / `0` | Force doors on / off, overriding the config mode entirely. |
| `HYPERIA_TOOL_CAP=<n>` | Override the resolved live-tool cap (core + open doors). |

## The meta-tools

Three tools drive the doors. On the ghost surface the search meta-tool is
`tool_search`; on the MCP surface it is `search_tools` (same behavior — the MCP
taxonomy names it `search_tools`).

| Tool | Effect |
| --- | --- |
| `open_tools(door)` | Open a door. Its tools appear in your list on the next `tools/list`. Over-cap opens evict the least-recently-used door(s) first (never the door just opened). |
| `close_tools(door)` | Close a door, freeing its slice of the budget. |
| `search_tools(query)` / `tool_search(query)` | Keyword-search the **full** catalog (open *and* closed). Each hit is tagged `[door: X — open\|closed]` so a model can discover a tool, then `open_tools` its door. |

### Live-tool budget & LRU eviction

`DoorState` maintains the invariant `core + Σ open-door tools ≤ cap`. Doors are held
in LRU order; opening one that would breach the cap evicts the oldest door(s) first.
A single door larger than the whole cap is still openable (it's allowed to exceed
rather than be un-openable). Executing any tool `touch`es its door → moves it to
most-recently-used so it survives eviction longest.

## Auto-open semantics

A model may call a tool that sits behind a **closed** door directly (it saw the name
in `search_tools`, in compressed history, or from an earlier turn). Rather than
rejecting the call, the surface **auto-opens** the door, runs the tool, and annotates
the result:

```
[door 'web' auto-opened by this call]
<normal tool output>
```

- **Ghost:** [`sidecar/src/ghost/agent.rs`](../sidecar/src/ghost/agent.rs) (~L931) —
  the closed-door call guard mutates the loop-local `DoorState` before dispatch.
- **MCP:** `call_tool` in [`sidecar/src/mcp.rs`](../sidecar/src/mcp.rs) does the same
  against the process-global MCP `DoorState`, then fires a `tools/list_changed`
  (below).

This is safe because doors are a menu, not a permission gate.

## MCP door state is process-global

rmcp's stateless streamable-HTTP transport (`stateful_mode: false`, chosen so sidecar
restarts don't 404 the client) builds a **fresh `HyperiaMcp` per request**, so a
per-connection door field would be wiped between calls — rmcp gives no per-connection
scratch space in stateless mode. The MCP surface therefore keeps **one process-global
`DoorState`** behind a `std::sync::Mutex` (`mcp_door_state()` in `mcp.rs`). Every
external client shares it. This is acceptable precisely because doors aren't a
security boundary. The lock is only ever held for short synchronous mutations, never
across an `.await`.

Because the `#[tool]` router can't dynamically filter itself, the MCP surface applies
doors at the `ServerHandler` interception layer:

- **`list_tools`** returns `core + open-door` router tools (via `DoorState::live_tools`),
  then appends the three synthetic meta-tools (they aren't `#[tool]`s — they mutate
  door state, which lives outside the router).
- **`call_tool`** intercepts the three meta-tool names, and auto-opens closed doors
  for real tools, before delegating to `self.tool_router.call(...)`.

With `mcp_tool_doors` **off**, both paths are byte-identical to the pre-doors server.

## `tools/list_changed` behavior (MCP)

When the MCP door set changes at runtime — `open_tools`, `close_tools`, or an
auto-open — the server sends the MCP `notifications/tools/list_changed` to the client
via the request's server peer:

```rust
let _ = context.peer.notify_tool_list_changed().await;
```

The `tools/list_changed` capability is advertised in `get_info` **only when
`mcp_tool_doors` is on** (that's the only mode where the set mutates).

### Delivery on the stateless HTTP transport — it works, with one nuance

We use the **stateless** streamable-HTTP transport. A natural worry is that a
stateless server has no persistent channel to push a server-initiated notification.
In practice it works, because of how rmcp handles a stateless POST:

1. Each incoming JSON-RPC request (e.g. a `tools/call`) is served over a
   `OneshotTransport` whose outbound side becomes the **SSE stream of that POST's
   response** (`transport/streamable_http_server/tower.rs`).
2. `OneshotTransport::send` (`transport.rs`) only *terminates* the stream on a
   `Response`/`Error`. **Notifications pass straight through** the same mpsc channel.
3. So a `notify_tool_list_changed()` sent *during* `call_tool` — before the result is
   returned — is emitted on that same POST's SSE stream, ahead of the tool result.
   A client that reads its POST response as SSE (Claude Code does) receives it.

**The nuance / limitation:** a stateless server has **no out-of-band push channel**.
The notification only rides along the SSE response of the very call that changed the
door state. There is no standalone server→client stream a client could subscribe to
for door changes triggered by *other* clients (they share the global state, but a
change made by client A does not spontaneously notify client B — B only learns on its
next `tools/list` or its own door-changing call). For our use case this is exactly
right: MCP door state only ever changes *as a result of a tool call*, so the
notification naturally piggybacks on that call's response.

On the **stdio** transport (a persistent bidirectional pipe) there is no such nuance —
notifications flow normally.
