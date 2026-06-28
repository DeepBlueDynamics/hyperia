# MCP Tools Reference

Hyperia's sidecar exposes its tool surface over the **MCP streamable-HTTP transport** at `http://localhost:9800/mcp` (Hyperia must be running). There are **63 tools**. For client setup (Claude Code, Codex, Antigravity), see the [README](../README.md#connect-an-agent-mcp-over-http).

This reference is generated from the `#[tool]` definitions in `sidecar/src/mcp.rs` — it is the source of truth.

## Addressing

Sessions are organized as **windows > tabs > panes**. Most tools accept optional `window` (id from `terminal_status` — not 0-based; the first window is typically `id=1`), `tab` (name), and `pane` parameters. The `pane` field accepts either the pane label (`"a"`, `"b"`, …) or the `paneId` from `terminal_status`; when a pane has no label, use its `paneId`. Omit all three to target the focused window's active pane.

**Output filtering (Maximus).** `terminal_run`, `terminal_screen`, and `tab_snapshot` accept `focus="<topic>"` to return only the relevant slice of output (filtered by a local Ollama model), and `raw=true` to bypass the filter and get the full text.

## Terminal

| Tool | Description |
|------|-------------|
| `terminal_status` | List all windows/tabs/panes in a nested hierarchy, with ids, labels/paneIds, dimensions, PIDs, and process. |
| `terminal_run` | Type a command, press Enter, and return the resulting screen (picks CR vs LF per target). Supports `focus`/`raw`. |
| `terminal_keys` | Send raw keystrokes to a pane (`\n` Enter, `\r` Return, `\t` Tab, `\x03` Ctrl-C). `interrupt=true` to send past a busy human. |
| `terminal_screen` | Read a pane's current screen as text. Supports `focus`/`raw`. |
| `terminal_split` | Split a pane (horizontal/vertical), optionally with a startup command. |
| `terminal_focus` | Move the human's view to a pane. Does **not** steal focus by default — it flashes the target tab (🔔) and reports where the human is; pass `force:true` to actually pull the view. |
| `terminal_close` | Close a pane. |
| `terminal_rename` | Rename a tab. |
| `terminal_new_tab` | Open a new tab, optionally with a startup command/profile. |
| `terminal_new_window` | Open a new window. |
| `terminal_where_pane` | Report which window/tab a pane lives in. |
| `terminal_flush_state` | Force-refresh the cached pane/session state. |
| `terminal_ui_key` | Send a UI-layer key event (Escape, Ctrl+C, etc.) to the renderer rather than the PTY. |
| `focus_pane` | Bring a specific pane to the foreground. |

## Pulse & liveness (agent coordination)

A **pulse** is a recurring prompt the sidecar re-submits into a pane on its own — independent of any agent's loop — to keep a stalled agent moving. Pulses never steal focus, are idle-gated by default, and auto-expire within an hour. Agents self-report liveness so the watchdog can tell real work from a quiet screen.

| Tool | Description |
|------|-------------|
| `pane_pulse_set` | Attach a recurring prompt to a pane (the watchdog). `idle_only` (default true) fires only when the pane looks stalled; otherwise fires every interval. Min interval 20s, auto-expires ≤1h, optional `max_fires`. Pulsing a pane you don't own prompts the human for consent; you **cannot** pulse your own pane (use `pane_on_idle`). |
| `pane_pulse_clear` | Clear a pulse by `id`, or by addressing the pane (window/tab/pane). |
| `pane_pulse_pause` | Pause or resume a pulse by `id`. |
| `pane_pulse_status` | List active pulses (target, interval, `idle_only`, paused, fires, time to expiry). |
| `pane_on_idle` | Arm a safe one-shot **self**-poke: the next time YOUR pane goes idle, the sidecar delivers your prompt back to you. Edge-triggered (one fire per running→idle transition), capped, ≤1h. In-pane agents only. |
| `pane_busy` | Self-report that this pane is working, valid for `ttl_secs` (re-call to extend) — suppresses pokes and **overrides** the on-screen heuristic (covers "thinking"/token-streaming that looks idle). |
| `pane_idle` | Self-report that this pane is now idle/done — clears busy so the watchdog resumes and any armed idle-callback can fire. |

## Web panes

| Tool | Description |
|------|-------------|
| `open_web_pane` | Open an embedded browser pane at a URL. |
| `web_pane_content` | Read the rendered text/content of a web pane. |
| `web_pane_eval` | Evaluate JavaScript in a web pane and return the result. |
| `web_pane_mouse` | Move/click the mouse at coordinates in a web pane. |
| `terminal_web_click` | Click an element in a web pane. |
| `terminal_web_reload` | Reload a web pane. |

## Sticky notes

| Tool | Description |
|------|-------------|
| `sticky_note_create` | Create a floating note (`text`, optional position/size/color). |
| `sticky_note_create_code` | Open a file-linked code note — renders a source file with syntax highlighting, live-updates on disk change. |
| `sticky_note_list` | List notes (ids + previews). |
| `sticky_note_read` | Read a note's full text by id. |
| `sticky_note_search` | Full-text (BM25) search across note content. |
| `sticky_note_update` | Edit a note's text (live-updates the open window). |
| `sticky_note_open` | Reopen a previously closed note window by id. |
| `sticky_note_close` | Close a note window (keeps the record). |
| `sticky_note_delete` | Permanently delete a note. |
| `sticky_note_schedule` | Schedule a note to fire/run on a timer. |

## Snapshots & observability

| Tool | Description |
|------|-------------|
| `tab_snapshot` | Read every pane's screen in a tab at once. Supports `focus`/`raw`. |
| `tab_image` | Capture a screenshot of a tab. |
| `shell_state` | Classify a pane's state (idle, running, dialog, empty). |
| `shell_confirm` | Auto-handle common prompts (trust dialogs, y/n confirmations). |
| `shell_log_search` | BM25 search across captured per-shell logs (lume). |
| `agent_status` | Set a tab's agent status light (connected/working/idle + label). |
| `auto_describe` | Use local Ollama to describe what a pane is doing. |
| `sidecar_logs` | Read recent sidecar log output. |
| `hyperia_version` | Report sidecar and Electron app versions. |

## Settings & profiles

| Tool | Description |
|------|-------------|
| `settings_get` | Read a configuration value (token redacted). |
| `settings_set` | Write a configuration value to `~/.hyperia/hyperia.json`. |
| `settings_list_profiles` | List the configured shell profiles. |
| `settings_add_profile` | Add a custom shell profile. |
| `settings_delete_profile` | Remove a profile. |
| `doctor` | Run a readiness report (providers, tokens, services). |

## Styles

| Tool | Description |
|------|-------------|
| `style_list` | List saved pane styles. |
| `style_create` | Create a reusable pane style. |
| `style_delete` | Delete a style. |

## Telemetry

| Tool | Description |
|------|-------------|
| `telemetry_toggle` | Enable/disable telemetry capture for a pane. |
| `telemetry_snapshot` | Read current per-pane metrics. |
| `telemetry_record` | Record a custom telemetry event. |
| `telemetry_reset` | Clear telemetry counters. |
| `dashboard_widgets` | Configure the dashboard widget layout (`http://localhost:9800/dashboard`). |

## Editing

| Tool | Description |
|------|-------------|
| `apply_text_edits` | Apply structured, range-based edits to a file on disk. |

## Discovery

| Tool | Description |
|------|-------------|
| `skills` | List Hyperia's higher-level capability areas and the tools that perform each — call this first to orient. |
