# MCP Tool Doors — progressive disclosure for Hyperia's tool surface

**Branch:** `mcp-tool-doors` · **Status:** plan · **Date:** 2026-07-02

**Mission:** Refactor both of Hyperia's tool surfaces — the built-in ghost agent loop and the external MCP server — to a "doors" progressive-disclosure model so that a 4B local model (Sailfish `gemma4-e4b`, 8k context) and token-billed cloud models never see 100+ tool schemas at once. Live tool set stays ≤ ~20 per turn.

Spec source: `C:\Users\kordl\Code\DeepBlueDynamics\nuts.services\sailfish\HYPERIA_TOOLCALL_GUIDE.md` ("Recommended: gate tools behind doors"), `HYPERIA_INTEGRATION.md` (endpoints/ladder/auth), `harness\PROFILE_RESULTS.md` (6/6 tool selection on a tight menu, 5–12x decode speedup on agentic output).

---

## 1. Code map (what exists today, with evidence)

All paths relative to `C:\Users\kordl\Code\DeepBlueDynamics\hyperia\`.

### 1.1 Ghost agent tool surface — `sidecar/src/ghost/registry.rs` (2747 lines)

- `ToolRegistry` (registry.rs:36–54) holds `builtins: Vec<ToolDef>` + `dynamic: Arc<Mutex<Vec<DynamicTool>>>` (runtime `tool_create` tools).
- `builtin_tool_defs()` (registry.rs:1818–2236) defines **34 builtins**: `terminal_keys, terminal_cd, terminal_run, terminal_split, terminal_focus, terminal_rename, terminal_where_pane, terminal_new_window, terminal_new_tab, terminal_close, terminal_status, terminal_screen, file_read, file_write, sticky_note_create, sticky_note_create_code, sticky_note_list, sticky_note_close, sticky_note_update, sticky_note_delete, web_fetch, session_report, tab_snapshot, shell_state, shell_confirm, terminal_ui_key, auto_describe, terminal_web_reload, terminal_web_click, web_pane_content, web_pane_eval, web_pane_mouse, open_web_pane, open_settings`.
- `tool_defs(provider, model)` (registry.rs:126–192) appends **23 more**: `tool_search, tool_create, watercooler`, 10× `memory_*`, 4× `show_*` (input/button/picker/form), `doctor, model_catalog, docker_run, help, maximus_explain, tool_mount`, plus all dynamic tools. **Total ≈ 57 + dynamic.**
- A crude precedent for doors already exists: the `is_small_ollama` hard allowlist (registry.rs:160–189) shrinks to 19 tools for `e2b/1b/2b/3b/small` Ollama models. This is the thing doors replaces.
- `execute()` (registry.rs:199–253) dispatches by name: internal tools matched first, then `execute_builtin` (HTTP calls to the sidecar API on `http_port`) or `execute_dynamic`. Unknown names return `"Unknown tool: {name}"` (registry.rs:1273).
- `tool_search` (registry.rs:394–411) already does keyword search over name+description — a ready-made "search door".

### 1.2 The agent loop — `sidecar/src/ghost/agent.rs`

- `run_loop()` computes `tool_defs` **once, before the loop** (agent.rs:301). Per iteration it derives `effective_tool_defs` by throttle tier filtering (agent.rs:363–383: tier 1 drops `terminal_screen`, tier 2 drops `terminal_*`, tier 3 keeps only `watercooler`+`memory_*`), then calls `provider.stream(&effective_system, &send_messages, &effective_tool_defs, 4096)` (agent.rs:437–439). **The tools array is already rebuilt per provider call — doors only needs to move the base `tool_defs` computation inside the loop and make it door-state-aware.**
- Tool execution: iterates `pending_tools` (**all** of them — N tool calls per turn are supported, agent.rs:544–704), one `tool_result` block per `tool.id` (agent.rs:699–704). `tool_mount` is intercepted in the loop itself before `registry.execute()` (agent.rs:566–628) — a clean precedent for intercepting door tools with mutable loop state.
- Session state persistence across user messages: `tool_call_count` + `recent_calls` are threaded through `run()` → `run_loop()` → returned → written back (agent.rs:221–222, 241–246, 270–273). **Open-door state should ride the same path.**
- One global `GhostSession` per sidecar (`ghost/api.rs:35`), `Arc<ToolRegistry>` built at api.rs:38 and **shared with the settings agent** (`settings/api.rs:104`, which calls the same `registry.tool_defs(provider, model)` at settings/api.rs:141).
- System prompt (agent.rs:11–105) is ~1.5–2k tokens and grows with recalled memories + the full `/api/status` terminal-state JSON (agent.rs:312–335). On an 8k model this plus 57 schemas is fatal — doors alone is not enough; see Phase 3.

### 1.3 Provider serialization — `sidecar/src/ghost/provider.rs`

- **Anthropic** (provider.rs:121–138): `ToolDef` → `{name, description, input_schema}` verbatim.
- **OpenAI-compatible** (provider.rs:1010–1025): `ToolDef` → `{"type":"function","function":{name, description, parameters: t.input_schema}}` — `input_schema` passed **verbatim** as `parameters`. This is exactly the mechanical map the Sailfish guide's `toOpenAI()` describes.
- **OpenAI streaming parser** (provider.rs:1133–1157): tracks N parallel `tool_calls` per turn via `active_tool_calls: HashMap<index,(id,name)>`; ids echoed verbatim into history by `build_openai_messages` (provider.rs:1239–1263); `reasoning_content` handled (provider.rs:1119–1130); `finish_reason:"tool_calls"` → `"tool_use"` (provider.rs:1161–1166). All three Sailfish gotchas are already handled on this path.
- **Ollama** (provider.rs:555–953): does NOT use native tool calling. Builds a structured-output `format` JSON Schema whose `tool_name` field is an **enum of the live tool names** (provider.rs:749–781) and runs 3 parallel temperature candidates. Single tool call per turn by construction. Doors directly shrinks this enum — a large accuracy win for small models.
- **Sailfish is not a provider** — there is no `"sailfish"` arm in `AnyProvider::from_config` (provider.rs:24–31). It rides `OpenAIProvider` with `config.endpoint = http://localhost:22343` and model fetched from `/v1/models`. No code change strictly required to talk to it; a `"sailfish"` alias arm + detection ladder is a nice-to-have (Phase 6).

### 1.4 External MCP server — `sidecar/src/mcp.rs` (3020 lines)

- rmcp 0.15 (`sidecar/Cargo.toml:37`), `#[tool_router]` on `impl HyperiaMcp` (mcp.rs:616), `#[tool_handler]` generates `list_tools`/`call_tool` from the router (mcp.rs:2904).
- **67 `#[tool]` methods** (mcp.rs:789 `terminal_keys` … mcp.rs:2242 `auto_describe`). `tools/list` returns all 67 schemas, every time. Combined with ghost: 57 + 67 = **124 tool definitions in the codebase** — the "100+" is real.
- Capabilities: `ServerCapabilities::builder().enable_tools().build()` (mcp.rs:2976–2978) — **`list_changed` is NOT advertised** today. rmcp 0.15 supports it: `enable_tool_list_changed()` exists (`rmcp-0.15.0/src/model/capabilities.rs:431`) and `peer.notify_tool_list_changed()` exists (`rmcp-0.15.0/src/service/server.rs:448`).
- **Transport constraint:** streamable HTTP is deliberately `stateful_mode: false` (mcp.rs:3006–3019) with a **factory that constructs a fresh `HyperiaMcp` per request** (mcp.rs:3013). Consequences: (a) server→client notifications like `listChanged` have no live stream to ride; (b) per-connection state on the handler does not persist. Door state for external clients must live in a **process-global map keyed by identity** (the `Authorization` bearer is already extracted per request by `forwarded_auth`, mcp.rs:18–24).
- Discovery precursor: the `skills` tool (mcp.rs:1518–1571) already defines a 9-area taxonomy (`terminal, web, stickies, snapshots, settings, editing, styles, telemetry, diagnostics`) with tool lists — informational only, it does not gate anything. **This taxonomy becomes the door registry.**
- No deferred/lazy listing exists anywhere on the wire today.

### 1.5 Context management — `sidecar/src/ghost/compressor.rs`

- `ContextCompressor::compress_messages` (compressor.rs:221–246): keeps the last `keep_recent = 6` messages verbatim (compressor.rs:12), summarizes everything older into one `[Earlier context — compressed]` block via local Ollama. Applied per model call (agent.rs:430–434) **only when Ollama is reachable** (agent.rs:339–345); otherwise full history ships.
- There is **no token-count budget**, no per-model context-window awareness, and tool results are only compressed via the optional `focus=`/Maximus path (registry.rs:236–252). An 8k Sailfish window can still overflow from 6 recent messages + system prompt + tools.

---

## 2. Answers to the Sailfish agent's questions (Q1–Q5)

**Q1 — How big is the tool surface actually, and how is the menu built per turn?**
57 ghost tools (34 builtins at registry.rs:1818–2236 + 23 appended at registry.rs:126–158, + dynamic `tool_create` tools) and 67 external MCP tools (mcp.rs:789–2248). The ghost sends the full 57 every turn unless the `is_small_ollama` allowlist (registry.rs:160–189) or a throttle tier (agent.rs:363–383) kicks in; the MCP server returns all 67 on every `tools/list`. Base list computed once per user message at agent.rs:301, provider request built per iteration at agent.rs:437–439.

**Q2 — MCP `inputSchema` vs OpenAI `parameters` mapping?**
Confirmed mechanical. `ToolDef.input_schema` (ghost/types.rs) is raw JSON Schema; the OpenAI provider passes it verbatim as `function.parameters` (provider.rs:1010–1025); Anthropic passes it verbatim as `input_schema` (provider.rs:121–130); rmcp derives the MCP `inputSchema` from the same shapes via `schemars`. The guide's `toOpenAI()` is exactly what Hyperia already does. No transformation layer needed for doors — a door just changes *which* defs are included.

**Q3 — Parallel `tool_calls` handling?**
Yes, N-per-turn is fully handled on the Anthropic and OpenAI paths: the OpenAI stream parser demuxes concurrent tool-call deltas by `index` (provider.rs:1133–1157), the executor loops over every `pending_tools` entry and emits one `tool_result` per `tool_use_id` (agent.rs:544–704, result push at 699–704), and ids are echoed verbatim on replay (provider.rs:1239–1263). Exception: the **Ollama structured-output path emits at most one tool call per turn by construction** (single `tool_name` field in the format schema, provider.rs:758–781). Sailfish will be driven through the OpenAI path, so parallel calls work.

**Q4 — Does the ghost truncate/trim history for small windows?**
Partially. `ContextCompressor` keeps the last 6 messages verbatim and Ollama-summarizes older ones (compressor.rs:12, 221–246; wired at agent.rs:430–434), but it is disabled when Ollama is down, has **no token budget**, and the system prompt balloons with the full terminal-state JSON (agent.rs:318–335). For an 8k model this is not sufficient — Phase 3 adds a hard token budget and a slim system prompt for doors mode.

**Q5 — Does deferred/lazy tool listing exist today?**
Not on the wire. External `tools/list` is the full router (mcp.rs:616 + 2904) and `list_changed` isn't advertised (mcp.rs:2976–2978); the stateless HTTP config (mcp.rs:3016) currently precludes delivering the notification anyway. The in-process analogs are `tool_search` (ghost, registry.rs:394–411) and `skills` (external, mcp.rs:1518–1571) — both return *text about* tools, neither changes what is callable/advertised. Doors makes these the front door.

---

## 3. Door taxonomy (grounded in actual tool names)

A single shared module `sidecar/src/doors.rs` defines the taxonomy once; both surfaces consume it.

```rust
pub struct Door {
    pub name: &'static str,
    pub description: &'static str,   // one line — this is all a closed door costs
    pub ghost_tools: &'static [&'static str],
    pub mcp_tools: &'static [&'static str],
}
```

### 3.1 Ghost agent (57 tools → core 11 + 7 doors)

**Core (always on, 11 defs incl. meta-tools):**
`terminal_status, terminal_run, terminal_screen, file_read, file_write, watercooler, memory_recall, memory_remember` + meta: `tool_search` (door-aware), `open_tools`, `close_tools`.
Rationale: run/read/screen/status matches the guide's level-0; watercooler is the yield primitive the throttle system depends on (agent.rs:379, 787); recall/remember are called constantly by the system prompt's memory rules (agent.rs:56–60).

| Door | Ghost tools | n | core+door |
|---|---|---|---|
| `terminal` | terminal_keys, terminal_cd, terminal_split, terminal_focus, terminal_close, terminal_new_tab, terminal_new_window, terminal_rename, terminal_where_pane | 9 | 20 ✓ (terminal_ui_key moved to `inspect`) |
| `inspect` | tab_snapshot, shell_state, shell_confirm, auto_describe, session_report, maximus_explain, terminal_ui_key | 7 | 18 ✓ |
| `web` | open_web_pane, web_pane_content, web_pane_eval, web_pane_mouse, terminal_web_click, terminal_web_reload, web_fetch | 7 | 18 ✓ |
| `stickys` | sticky_note_create, sticky_note_create_code, sticky_note_list, sticky_note_update, sticky_note_close, sticky_note_delete | 6 | 17 ✓ |
| `memory_deep` | memory_dream, memory_connect, memory_status, memory_sql, memory_inspect, memory_keystone, memory_neighbors, memory_embody | 8 | 19 ✓ |
| `ui` | show_input, show_button, show_picker, show_form, tool_mount | 5 | 16 ✓ |
| `settings` | doctor, model_catalog, docker_run, help, open_settings + (settings_get/settings_set where exposed) | 5–7 | ≤18 ✓ |
| `create` | tool_create + all dynamic tools | 1+N | capped |

Every door body ≤ 10, so core + any single door ≤ 21 → with the ≤20 cap, opening door B evicts door A (LRU). Two small doors (e.g. `web` 7 + `ui` 5 = 23) still evict; that is the intended breadth bound.

**Settings agent** (shares the registry, settings/api.rs:141): gets its own `DoorState` with a settings-biased core (`doctor, model_catalog, help, show_input, show_button, show_picker, show_form, docker_run` + meta) and the same door catalog — today it receives all 57 tools, which is worse than what doors gives it.

### 3.2 External MCP (67 tools → core 12 + 9 doors)

Reuse and extend the existing `skills()` taxonomy (mcp.rs:1522–1568):

**Core:** `terminal_status, terminal_run, terminal_screen, terminal_keys, terminal_split, tab_snapshot, request_access, request_token, hyperia_version` + meta `open_tools, close_tools, search_tools` (the `skills` tool is subsumed by `open_tools` with no args = list doors; keep `skills` as an alias during transition).

| Door | MCP tools | n |
|---|---|---|
| `terminal_layout` | terminal_new_tab, terminal_new_window, terminal_close, terminal_focus, terminal_rename, terminal_where_pane, terminal_cd, terminal_set_window_size, terminal_flush_state | 9 |
| `inspect` | terminal_scrollback, shell_log_search, shell_state, shell_confirm, tab_image, auto_describe, terminal_ui_key | 7 |
| `web` | open_web_pane, web_pane_content, web_pane_eval, web_pane_mouse, terminal_web_click, terminal_web_reload | 6 |
| `stickys` | sticky_note_create, sticky_note_create_code, sticky_note_list, sticky_note_search, sticky_note_read, sticky_note_update, sticky_note_open, sticky_note_close, sticky_note_delete, sticky_note_schedule | 10 |
| `pulse` | pane_busy, pane_idle, pane_on_idle, pane_pulse_set, pane_pulse_clear, pane_pulse_pause, pane_pulse_status | 7 |
| `settings` | settings_get, settings_set, settings_list_profiles, settings_add_profile, settings_delete_profile, doctor | 6 |
| `styles` | style_list, style_create, style_delete, dashboard_widgets | 4 |
| `telemetry_diag` | telemetry_toggle, telemetry_snapshot, telemetry_record, telemetry_reset, sidecar_logs, audit_search, agent_status | 7 |
| `editing` | apply_text_edits | 1 |

---

## 4. Mechanism A — the ghost loop (registry-side)

### 4.1 `DoorState` (new, in `sidecar/src/doors.rs`)

```rust
pub struct DoorState {
    open: Vec<String>,        // insertion-ordered = LRU (front = oldest)
    cap: usize,               // default 20, env HYPERIA_TOOL_CAP
    enabled: bool,            // doors mode on/off
}
impl DoorState {
    pub fn open_door(&mut self, name) -> Vec<String /*evicted*/>;  // enforce cap, LRU-evict
    pub fn touch(&mut self, tool_name);  // any call to a door's tool moves it to MRU
    pub fn close_door(&mut self, name);
}
```

Lives in `GhostSession` next to `tool_call_count`/`recent_calls` (agent.rs:120–123), threaded through `run()` → `run_loop()` exactly like the throttle state (agent.rs:221–222, 237–238), returned in the result tuple and written back via `set_throttle_state`'s sibling `set_door_state` (agent.rs:270–273). Reset in `GhostSession::reset()` (agent.rs:275–283).

### 4.2 Registry changes (`registry.rs`)

- `tool_defs(provider, model)` → `tool_defs(provider, model, doors: Option<&DoorState>)`. When `doors` is `Some(enabled)`: emit core defs + `open_tools`/`close_tools`/`tool_search` meta defs + full schemas for tools of open doors + **nothing else**. When `None`/disabled: current behavior (full list). Update the two other call sites: registry.rs:396 (`handle_tool_search` — searches the FULL catalog always, that is the point) and settings/api.rs:141.
- **Delete the `is_small_ollama` allowlist** (registry.rs:160–189) — replaced by doors `auto` mode.
- `open_tools` def: `{door: string enum of door names}` — description lists each door name + its one-liner (this is the entire cost of the closed catalog: ~9 lines). `close_tools`: same param.
- `tool_search` result lines gain a door hint: `"- web_pane_eval [door: web — closed]: Run JS in a web pane…"` + trailing `"Call open_tools(door=\"web\") to make these callable next turn."`

### 4.3 Loop changes (`agent.rs`)

1. Move `registry.tool_defs(...)` from before the loop (agent.rs:301) to the top of each iteration, passing the current `DoorState`. Throttle-tier filtering (agent.rs:363–383) then applies **on top of** the door-assembled list (tiers still win — they are a stricter emergency brake).
2. Intercept `open_tools`/`close_tools` in the executor exactly like `tool_mount` (agent.rs:566–628): mutate the loop-local `DoorState`, and synthesize the result the guide prescribes ("gather on entry, expand next turn"):
   ```
   Door 'web' opened. Available on your NEXT turn (7 tools):
   - open_web_pane: Open a URL in a new web pane tab…
   - web_pane_content: Read the current page as markdown…
   …
   [doors open: terminal(idle 3), web] [live tools next turn: 18/20]
   [evicted: stickys — reopen with open_tools if needed]
   ```
   Name+one-line only — the schemas land in the next request's `tools` array, not in the transcript.
3. **Closed-door call guard:** if the model calls a tool that exists in the catalog but is behind a closed door (it saw the name in `tool_search`, in compressed history, or hallucinated it from an earlier turn), **auto-open the door, execute the tool, and prepend a note** to the result: `"[door 'web' auto-opened by this call]"`. This is deterministic, saves a full round-trip for the 4B model, and never grants anything doors was withholding — consent/identity gating happens at the HTTP API layer, not in the menu (registry.rs:57–73 Ghost token; mcp.rs consent notes). Truly unknown names keep the existing `"Unknown tool: {name}"` (registry.rs:1273).
4. `touch()` on every executed tool; doors idle for ≥ 6 consecutive tool rounds are candidates for LRU eviction first. v1 collapse policy = **explicit `close_tools` + LRU eviction on cap overflow only** (no timer-based auto-close — keep it deterministic and testable).
5. System prompt: in doors mode, replace the "Honesty about tools" paragraph (agent.rs:17–24) with a doors contract: *"Your tool list shows a small core plus doors. A door is a category opener: call `open_tools(door=…)` (or `tool_search`) and the tools behind it become callable on your next turn. Never invent tool names; if a capability seems missing, search first."*
6. Config: `config.agent.tool_doors = "on" | "off" | "auto"` (read in `ghost::load_config`), default `auto` = on for `ollama`/openai-endpoint-override (Sailfish)/small models, on-with-larger-cap for cloud providers (doors also cuts token billing; Anthropic/OpenAI get `cap=24`). Env `HYPERIA_TOOL_DOORS=0|1` overrides. History replay is safe: neither Anthropic nor OpenAI requires past `tool_use`/`tool_calls` names to still be present in `tools`, and the Ollama path re-encodes history as plain JSON text (provider.rs:597–735).

### 4.4 Ollama/Sailfish specifics

- Ollama structured path: the `tool_name` enum (provider.rs:749–756) now contains ~18 names instead of ~57 — direct selection-accuracy win; no code change needed beyond receiving a shorter `tools` slice.
- Sailfish rides `OpenAIProvider` (endpoint `http://localhost:22343`). Send `temperature: 0` for tool turns per the guide — note: OpenAIProvider currently sends **no** temperature (provider.rs:997–1008); add `"temperature": 0` when doors mode is active for a small-model provider (or make it config).

---

## 5. Mechanism B — the external MCP surface (`mcp.rs`)

What "progressive disclosure" means over MCP: `tools/list` returns core + meta-tools; calling `open_tools` mutates server-side door state; the client learns about new tools either via a `notifications/tools/list_changed` (when a stateful session exists) or by re-listing because the `open_tools` result text tells it to. rmcp supports both halves (`enable_tool_list_changed()` — capabilities.rs:431; `notify_tool_list_changed()` — service/server.rs:448), **but Hyperia's transport is stateless** (mcp.rs:3016, per-request handler factory at mcp.rs:3013), so:

1. **Door state store:** process-global `OnceLock<Mutex<HashMap<String /*identity*/, DoorState>>>` keyed by the bearer token from `forwarded_auth` (mcp.rs:18–24); anonymous callers share one `"anon"` bucket. Entries expire after ~30 min idle.
2. **Hand-written `list_tools`/`call_tool`:** drop the `#[tool_handler]` macro (mcp.rs:2904) and implement `ServerHandler::list_tools` manually: `self.tool_router.list_all()` filtered to core + open doors for this identity, plus synthesized `open_tools`/`close_tools`/`search_tools` meta-tools (the existing `skills` method becomes the data source for `open_tools` with no args). `call_tool`: meta-tools handled inline; router tools delegate to `self.tool_router.call(...)` with the same auto-open-on-closed-door behavior as the ghost (never a hard error for a real tool — MCP clients cache lists and will legitimately call "closed" tools).
3. **Compat mode is the default.** `HYPERIA_MCP_DOORS=1` (env) or `config.mcp.doors=true` enables gating; otherwise `list_tools` returns all 67 as today. Rationale: Claude Code and other long-lived MCP clients cache `tools/list` and rely on the full set (the Claude Code harness already defers `mcp__hyperia__*` schemas client-side, so the external win is smaller than the ghost win). Additionally honor a per-request opt-in so one client can get doors while others don't: `Mcp-Doors: 1` header (visible via the injected `axum::http::request::Parts`, same mechanism as `forwarded_auth`).
4. **`listChanged` (best-effort, Phase 5):** advertise `enable_tool_list_changed()` only when doors mode is on; when a stateful session exists (stdio transport `run_mcp_stdio` mcp.rs:2985–2990 — this one IS stateful), fire `notify_tool_list_changed` after `open_tools`/`close_tools`. On stateless HTTP, rely on the result-text contract: `open_tools` result ends with `"Re-run tools/list to fetch the new schemas."` Sailfish's own harness rebuilds the `tools` array every turn anyway (guide §"The loop"), so it needs no notification.
5. `skills` stays as a read-only alias forever (cheap, existing clients call it).

---

## 6. Phased build order (small commits on `mcp-tool-doors`, each testable against live MCP at `localhost:9800`)

**Phase 0 — measurement baseline (no behavior change).**
Add a `tracing::info!` line in `run_loop` logging per-iteration tool count + serialized-schema byte size, and the same in MCP `list_tools`.
*Test:* JSON-RPC `tools/list` against `http://localhost:9800/mcp` (curl or an MCP inspector); confirm 67 tools and record the byte/token size (expect ~15–25k tokens). Commit: `doors: instrument tool-surface size`.

**Phase 1 — `doors.rs` + DoorState (pure, unit-tested).**
New module with the taxonomy tables (§3), `DoorState` with cap/LRU/eviction, and exhaustive unit tests: cap enforcement, LRU order, auto-open eviction, every catalog tool belongs to exactly one door or core, every door ≤ 10 tools (compile-time-ish assert in a test).
*Test:* `cargo test doors`. Commit: `doors: taxonomy + DoorState`.

**Phase 2 — ghost registry + loop wiring, default OFF.**
`tool_defs(provider, model, doors)`, meta-tool defs, per-iteration rebuild in `run_loop`, `open_tools`/`close_tools` intercept (tool_mount pattern), auto-open guard, door-aware `tool_search`, `set_door_state` session plumbing, settings/api.rs call-site update. Flag `HYPERIA_TOOL_DOORS` default off.
*Test:* run sidecar with `HYPERIA_TOOL_DOORS=1` + Ollama/Sailfish configured; in the ghost chat ask "open google and read the page" — verify turn 1 offers no `web_pane_*`, the model calls `open_tools(web)` (or `web_fetch` path), turn 2 tools array contains the web door (visible in the Phase-0 log line), task completes. Regression: flag off → byte-identical tool list to main. Commit: `doors: ghost loop progressive disclosure (flagged)`.

**Phase 3 — small-model hardening.**
Delete `is_small_ollama` allowlist; `config.agent.tool_doors=auto` logic; slim doors-mode system prompt; add `temperature: 0` for tool turns on the OpenAI provider when configured; add a hard token-budget guard in `compress_messages` (estimate 4 chars/token; if system+tools+history > budget from a `config.agent.context_tokens`, drop `keep_recent` from 6 toward 2 before shipping).
*Test:* Sailfish live at `localhost:22343` (detection: `GET /api/status`): run the guide's ls-and-count task through the ghost with doors on; verify prompt_tokens in Sailfish's response stays under ~2k on turn 1 (guide's example was 129 with 2 tools; we should land ~1–2k with core+doors), and 6/6-style selection on a 3-task smoke script. Commit: `doors: auto mode for small models, 8k budget`.

**Phase 4 — external MCP surface, default OFF.**
Global identity-keyed door store; replace `#[tool_handler]` with hand-written `list_tools`/`call_tool`; meta-tools; `HYPERIA_MCP_DOORS` env + `Mcp-Doors` header; `skills` alias kept.
*Test:* against live `localhost:9800/mcp` — (a) flag off: `tools/list` returns 67 (Claude Code session keeps working, run one `terminal_status` from a real Claude Code session); (b) `Mcp-Doors: 1`: list returns ~15, `open_tools(stickys)` then re-list returns +10, calling `sticky_note_list` while door closed auto-opens and succeeds. Commit: `doors: MCP tools/list gating (flagged, identity-keyed)`.

**Phase 5 — notifications + polish.**
`enable_tool_list_changed()` when doors on; `notify_tool_list_changed` on the stdio transport; door-state surfaced in `agent_status`; docs in BUILDING.md/README; consider `stateful_mode: true` opt-in path for clients that want real notifications (revisit the restart-404 tradeoff documented at mcp.rs:2996–3005 before flipping).
*Test:* stdio MCP client sees `listChanged` after `open_tools`. Commit: `doors: listChanged + docs`.

**Phase 6 (optional, adjacent) — Sailfish provider alias + detection ladder.**
`"sailfish"` arm in `AnyProvider::from_config` → `OpenAIProvider` with endpoint default `http://localhost:22343`, model id fetched from `/v1/models`, `/api/status` health probe, 120s first-call warmup handling per HYPERIA_INTEGRATION.md. Separate commit(s); not required for doors.

---

## 7. Risks & mitigations

- **Breaking external agents (Claude Code caches full `tools/list`).** Doors on the MCP surface is opt-in (`HYPERIA_MCP_DOORS` / `Mcp-Doors` header), default off forever until clients prove out. Ghost-side doors never affects external clients.
- **Doors ≠ security.** The menu is a UX/token concern; consent (`request_access`, soft-wall 202/403) and identity (Ghost's own `hyp_agent_` token, registry.rs:57–73) remain enforced at the HTTP API. Auto-open-on-call is therefore safe by construction — document this invariant in `doors.rs`.
- **Widgets/`tool_mount`:** if the `ui` door is closed when the settings flow needs `show_picker`, the system-prompt flows (agent.rs:97–105) would name unavailable tools. Mitigation: settings agent's DoorState pre-opens `ui`+`settings`; ghost auto-open guard covers stragglers; audit SYSTEM_PROMPT for tool names and gate those paragraphs on door membership (Phase 2 checklist).
- **Settings agent shares the registry** (settings/api.rs:104,141): signature change must update it in the same commit; give it its own DoorState (§3.1) — never share door state between the two sessions.
- **Throttle-tier interaction:** tiers filter after door assembly; tier 3's `memory_*`-only list must still include `watercooler` (it does) — add a test that tiered filtering of a doored list is non-empty.
- **Model calls a door name as if it were the tool** (`web` instead of `open_tools(door=web)`): accept `web`/`open_web` as aliases in the executor intercept; cheap and 4B-friendly.
- **History references to closed tools:** benign on Anthropic/OpenAI (past tool_use ids don't need live defs) and the Ollama path re-encodes history as text; covered by Phase-2 regression run.
- **Compressor summarizing away door announcements:** the "what's now available" text is transcript-only; ground truth is the DoorState, which is never derived from the transcript — announcements can be lossy without breaking anything.
- **rmcp macro removal risk:** hand-written `list_tools` must stay in sync with the router — build it from `self.tool_router.list_all()` (never a hand-maintained list) and filter by name; add a test asserting router names ⊆ doors catalog ∪ core.

### Critical files
- `sidecar/src/ghost/registry.rs` (tool catalog, `tool_defs`, `execute`, tool_search; the is_small_ollama allowlist to delete)
- `sidecar/src/ghost/agent.rs` (run_loop per-turn tools assembly at :301/:363–439, tool_mount-style intercept at :566, session state plumbing)
- `sidecar/src/mcp.rs` (67 #[tool] methods, `skills` taxonomy at :1518, ServerHandler/get_info at :2904, stateless transport at :3006)
- `sidecar/src/ghost/provider.rs` (per-provider tool serialization :121/:1010, Ollama tool_name enum :749, OpenAI parallel tool_calls :1133)
- `sidecar/src/ghost/compressor.rs` (keep_recent/compress_messages :221 — 8k token budget hook)
- NEW: `sidecar/src/doors.rs` (shared Door taxonomy + DoorState)
