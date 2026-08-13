# Hyperia Event Stream API (v1)

Stream terminal state out of the sidecar to external apps over WebSocket. Primary
consumer: a standalone, containerized **3D "situation room"** that renders each
pane on its own virtual monitor, plus a "walk up to a monitor" full-fidelity view.

Two modes, deliberately different fidelity/cost trade-offs:

| Mode | Endpoint | Scope | Payload | Use |
|---|---|---|---|---|
| **Wall** (quick) | `/ws/wall` | ALL panes at once | sidecar-rendered cell-grid **keyframe + row deltas** (JSON) | the monitor wall / overview |
| **Focused** (full fidelity) | `/ws/pane/{paneId}` | one pane | **raw PTY bytes** (binary) + scrollback replay + keystroke input | pixel-exact interactive terminal |
| **Pixels** (rendered) | `/ws/pixels/{paneId}?w=&h=&fps=` | one pane | **JPEG frames** (binary), dirty-skip | WEB panes (no PTY) / exact rendered fidelity |

## Why this is cheap to build (existing sidecar capabilities)

Do **not** re-implement a terminal — the sidecar already:
- Aggregates every pane: `Bridge.sessions: HashMap<uid, SessionInfo>` across all windows/tabs/panes, with window id / tab / active flags / pid / cols×rows (this is what `terminal_status` renders — reuse that tree builder).
- Keeps a live **vt100 `ScreenBuffer`** per pane, fed by the raw PTY stream (`SessionData`) with **no Electron round-trip** (`bridge.rs` `get_screen_text_by_uid`).
- Emits the full color grid: `ScreenBuffer::screen_dump()` → per-cell char + fg + bg + attrs.
- Computes **row-level diffs**: `ScreenBuffer::diff()` → changed rows since last snapshot. This IS the wall delta payload.

The stream is a **fan-out over data that already exists**, not new emulation.

---

## Transport & endpoints

WebSocket only. (SSE rejected: text-only, unidirectional, poor for binary/backpressure.)

- `GET /ws/wall` — wall mode.
- `GET /ws/pane/{paneId}` — focused mode. `paneId` = full pane UUID **or a 4+ char prefix**, same addressing as MCP tools.

Base: `ws://<host>:9800` (`HYPERIA_PORT` overrides). The sidecar binds `0.0.0.0` on Linux, so a container reaches it at `ws://host.docker.internal:9800`.

## Auth

- Optional `Authorization: Bearer <token>` header (native clients) **or** `?token=<token>` query param (browsers can't set WS headers).
- Reads are **anonymous-allowed by default**, matching `terminal_status`/`terminal_screen`. Set `config.stream.requireToken = true` to reject tokenless connections (401 before upgrade). Accepted tokens: `hyp_agent_*`, pane, or system.
- Identity is logged for audit. No per-pane consent prompt for read streams (consistent with existing read policy).

## Framing conventions

- **Control + grid frames**: WebSocket **TEXT** frames, JSON, always carrying `t` (type) and `v` (protocol version = 1).
- **Raw PTY frames** (focused only): WebSocket **BINARY** frames = raw PTY bytes verbatim, no header (the connection is single-pane).
- JSON is UTF-8; field names short + stable. Clients MUST ignore unknown `t` values and unknown fields (forward-compat).

## Frames common to both modes

```jsonc
{ "t":"hello", "v":1, "mode":"wall|focused", "serverVersion":"0.16.x", "heartbeatMs":15000 }
{ "t":"ping" }            // server → client every heartbeatMs; reply { "t":"pong" }
{ "t":"pong" }
{ "t":"error", "code":"...", "message":"..." }   // then close
{ "t":"bye", "reason":"..." }                    // server closing
```

---

## Cell / grid data model (wall mode)

A screen is `rows × cols` cells. A row on the wire:

```jsonc
{ "y":3, "cells": [ ["h", fg, bg, attrs], ["i", fg, bg, attrs], ... ] }
```

- cell = compact tuple `[char, fg, bg, attrs]`.
- `char`: 1 grapheme string; `""` = blank cell.
- `fg`/`bg`: `"default"` | `"idx:N"` (0–255 palette) | `"#RRGGBB"`.
- `attrs`: integer bitfield — `1` bold, `2` italic, `4` underline, `8` inverse, `16` dim, `32` strike; `0` none.
- Trailing default-blank cells MAY be omitted (a row shorter than `cols` ⇒ remainder is default blanks).

> ⚠️ The current `ScreenBuffer::screen_dump()` serializes colors with `format!("{:?}", cell.fgcolor())` (Rust Debug — e.g. `Idx(4)`). That MUST be normalized to the wire format above (`normalize_color(vt100::Color) -> String`) before shipping. Do not leak Debug strings.

---

## Wall mode protocol (`/ws/wall`)

Query: `?fps=30` (delta coalescing cap, default 30, clamp 1–60), `?token=`.

Server → client sequence:

1. `hello` (`mode:"wall"`).
2. `topology` — the full tree:
```jsonc
{ "t":"topology", "windows":[
  { "id":1, "focused":true, "tabs":[
    { "tabId":"...", "name":"...", "active":true, "panes":[
      { "paneId":"...", "title":"...", "cols":120, "rows":40, "active":true,
        "state":"running|idle|busy", "app":"n8", "cwd":"..." } ] } ] } ] }
```
3. One `frame` keyframe per pane (full grid):
```jsonc
{ "t":"frame", "paneId":"...", "cols":120, "rows":40,
  "cursor":{"x":5,"y":3,"visible":true}, "rows_data":[ {row}, ... ] }
```
4. Live, coalesced at `fps`:
```jsonc
{ "t":"delta",  "paneId":"...", "cursor":{...}, "rows_data":[ {y,cells}, ... ] }   // changed rows only
{ "t":"resize", "paneId":"...", "cols":..,"rows":.. }   // immediately followed by a fresh "frame"
{ "t":"state",  "paneId":"...", "state":"running|idle|busy", "app":"...", "cwd":"..." }
{ "t":"topo",   "op":"add|remove|activate", "paneId":"...", /* pane fields on add */ }
```
5. `resync` — server dropped deltas for a lagging client:
```jsonc
{ "t":"resync" }   // then re-sends topology + all frames; client discards prior state
```

Client → server:
```jsonc
{ "t":"resync" }              // force a full refresh
{ "t":"fps", "fps":15 }       // change cadence
```

Deltas come from `ScreenBuffer::diff()`, **coalesced per pane** within the frame budget (many PTY writes between frames collapse to one delta).

---

## Focused mode protocol (`/ws/pane/{paneId}`)

Query: `?scrollback=1` (replay on connect, default true), `?token=`.

Server → client:

1. `hello` (`mode:"focused"`).
2. `meta`:
```jsonc
{ "t":"meta", "paneId":"...", "title":"...", "cols":120, "rows":40, "state":"...", "cwd":"..." }
```
3. **Scrollback replay** (if `scrollback=1`): one or more **BINARY** frames = the pane's buffered raw PTY bytes (bounded ring, default 512 KB), oldest→newest, then a TEXT frame `{ "t":"replay-end" }`. Fed to a fresh VT this reconstructs the current screen + as much scrollback as the ring holds.
4. **Live**: **BINARY** frames = raw PTY bytes as they arrive. Interleaved TEXT control frames: `resize` (client MUST apply to its VT before subsequent bytes), `state`, `bye`.

The client runs its own VT (xterm.js / vte / alacritty_terminal) → pixel-exact colors, cursor, animations, sixel/iTerm images, TUIs. This is the full-fidelity path.

**Input (interactive typing):** the client sends keystrokes back over the SAME
socket as **BINARY** frames — the UTF-8 bytes of xterm's `onData`
(`term.onData(d => ws.send(new TextEncoder().encode(d)))`). The sidecar writes
them straight to the pane's PTY as **human input** (a direct write, NOT the
agent-consent path). So on the wire: server→client BINARY = PTY output + TEXT =
control; client→server BINARY = keystrokes. (Trust: `/ws/pane` input trusts
whoever holds the socket — fine on localhost / your own containers; gate behind
a token via `config.stream.requireToken` if exposing more widely.)

---

## Pixels mode protocol (`/ws/pixels/{paneId}`)

For panes with **no PTY** — WEB panes especially — the only way onto a monitor is
rendered pixels. Query: `?w=640&h=400&fps=15` (defaults), `?token=`.

- Server → `hello` (mode `"pixels"`), then a `meta` (`{t,paneId,w,h,fps,format:"jpeg"}`),
  then **BINARY** frames = JPEG of the pane captured at the requested `w×h`.
- **The client requests the size** (`w`/`h`) — Hyperia captures at exactly that
  texture resolution, so no pixels are wasted. Use **LOD**: near/large monitors
  ask for a crisp frame, far/edge ones a small one — that's where the bandwidth
  savings live.
- Frames are **flat / front-facing**. The 3D scene applies the monitor's tilt via
  texture mapping (perspective-correct, per-frame, free). Do NOT ask Hyperia to
  pre-tilt — that bakes in one camera angle and wastes foreshortened pixels.
- Pull-based: Electron captures (`webContents.capturePage` → resize → JPEG) only
  while a client is watching; byte-identical frames are dropped, so a static page
  costs ~nothing. (v2: `beginFrameSubscription` dirty-rects, then WebRTC video for
  full-motion efficiency.)
- **Terminals stay on `/ws/pane`** (data — KB not MB, crisp text, interactive);
  `/ws/pixels` is for web panes.

## Backpressure & lifecycle

- Global fan-out is a `tokio::sync::broadcast<StreamEvent>`. Per-connection tasks own their sockets; a slow client never stalls ingest or other clients.
- On `broadcast::error::RecvError::Lagged`, the per-connection task: **wall** → send `resync`; **focused** → `error{code:"slow-consumer"}` + close (raw bytes are ordered/lossless; client reconnects + replays).
- Per-connection send buffers are bounded; exceeding the high-watermark triggers the same lag path.
- Pane close → `topo{op:"remove"}` (wall) / `bye` (focused). Heartbeat drops dead sockets.

## Versioning

`v:1`. Additive fields/`t` values are non-breaking (clients ignore unknowns). Breaking changes bump `v`; `hello` advertises the version.

---

## Server implementation notes (sidecar dev agent)

**Surgical rule: `bridge.rs` is already ~2.1k lines and `mcp.rs` ~3.5k — do NOT grow them.** All new logic lives in a new module.

- **New `sidecar/src/stream.rs`** owns: `StreamHub` (`broadcast::Sender<StreamEvent>`), the two axum WS handlers, color/cell normalization, and the per-connection tasks + coalescing.
- `StreamEvent` enum: `PaneRegistered`, `PaneData{uid, bytes:Bytes}`, `PaneResized{uid,cols,rows}`, `PaneRemoved{uid}`, `PaneState{uid,state,app,cwd}`, `TopologyChanged`.
- **Thin hooks in `bridge.rs` `handle_message`** (`match msg_type`) — after each existing arm mutates state, one `hub.publish(...)` call: `SessionRegister`→`PaneRegistered`+`TopologyChanged`; `SessionData`→ push bytes into the pane raw ring **and** `PaneData`; resize→`PaneResized`; unregister→`PaneRemoved`; shellstate→`PaneState`.
- **Raw ring**: add `raw_ring: VecDeque<u8>` (cap `config.stream.rawRingBytes`, default 512 KB) to `SessionInfo`; push on `SessionData`, trim to cap. Only for focused replay.
- **Wall delta computation lives in the per-connection task** (call `ScreenBuffer::diff()` under the sessions lock, copy out, release), NOT the hub — so one slow client can't stall others. Coalesce with `tokio::time::interval(1000/fps)`.
- **Reuse** the `terminal_status` tree builder for the `topology` frame (factor into a shared `fn build_topology(&self) -> Topology` in `bridge.rs`, small + local). **Reuse** existing `resolve()` for auth.
- Routes in `main.rs` next to `/api/tts`, `/mcp`: `.route("/ws/wall", get(stream::wall_handler)).route("/ws/pane/:id", get(stream::pane_handler))`.
- Optional `stream` cargo feature (default on) if binary size matters.

### Suggested build order (independent, parallelizable tasks)
1. `stream.rs` skeleton: `StreamHub`, `StreamEvent`, route registration, `hello`/`ping` — connect returns `hello` then idles. *(scaffolded by this change — see below)*
2. Ingest hooks + raw ring in `bridge.rs` (publish events; no consumer yet).
3. Wall handler: topology + keyframes + coalesced diffs + resync.
4. Focused handler: meta + binary replay + live binary passthrough.
5. Config (`config.stream.{requireToken,rawRingBytes}`) + auth gate.
6. Tests: a headless WS client asserting hello→topology→frame ordering; a 200-write burst coalesces to ≤fps deltas; lagged client gets `resync`.

## Client guidance (3D-app dev agent)

- Connect `/ws/wall`; build the monitor layout from `topology` (window→tab→pane). Each pane = one virtual monitor; group by window/tab.
- Render each grid to a texture: draw all rows on `frame`, patch changed rows on `delta`; use `fg`/`bg`/`attrs`; draw the caret from `cursor`.
- Drive room ambience from `state` — e.g. a glowing bezel for a `running` agent, dim for `idle`.
- "Walk up to a monitor" → open `/ws/pane/{id}`, feed bytes to a real VT widget for pixel-exact fidelity + scrollback.
- On `resync`/reconnect, clear local state and rebuild from the next `topology`+`frame`s.

## Out of scope (v1) / future

- (Done in a later build: focused-stream input — see the Focused section.)
- Bell/audio events; explicit sixel/iTerm image events (raw PTY already carries them in focused mode).
- Multi-host aggregation (#138 / #139) — a `/ws/wall` that federates remote sidecars.
- Per-pane ACL beyond the global token gate.
