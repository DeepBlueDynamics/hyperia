# MCP Tools Reference

Hyperia's sidecar exposes its tool surface over the **MCP streamable-HTTP transport** at `${HYPERIA_MCP_URL:-http://localhost:9800/mcp}` (Hyperia must be running). For client setup (Claude Code, OpenAI Codex, Grok, Google Antigravity), run `hyperia mcp` for ready-to-paste commands, or see the [README](../README.md#connect-an-agent-mcp-over-http).

This reference mirrors the `#[tool]` definitions in `sidecar/src/mcp.rs` — the code is the source of truth; verify against the live catalog with `hyperia tools`.

## Addressing

Sessions are organized as **windows > tabs > panes**. Most tools accept optional `window` (id from `terminal_status` — not 0-based; the first window is typically `id=1`), `tab` (name), and `pane` parameters. The `pane` field accepts a pane's friendly name (e.g. `"Brilliant Peacock"`) or its `paneId` from `terminal_status` (full UUID or a 4+ character prefix). Omit all three to target the focused window's active pane.

**Output filtering (Maximus).** `terminal_run`, `terminal_screen`, and `tab_snapshot` accept `focus="<topic>"` to return only the relevant slice of output (filtered by a local Ollama model), and `raw=true` to bypass the filter and get the full text.

## Discovery

| Tool | Description |
|------|-------------|
| `skills` | List Hyperia's higher-level capability areas and the tools that perform each — call this first to orient. |

## Identity & consent

Reads work anonymously; state-changing tools need an identity (`Authorization: Bearer` — a pane's `HYPERIA_AGENT_TOKEN` or a persistent agent token). Acting on a pane you don't own asks the human first.

| Tool | Description |
|------|-------------|
| `request_token` | Mint (or re-fetch) a persistent `hyp_agent_…` identity token — call when a write returns "No identity". The reply explains immediate use (direct HTTP works without restart) and permanent config. |
| `request_access` | Ask the human to grant you access to a pane/tab (type, run commands, …) with a stated `purpose`. Raises the consent prompt. |
| `audit_search` | Search the audit log — who did what, when, and the decision (identity/path/status filters). |
| `consent_log` | Query the consent ledger: every prompt raised and every decision the user made. |

## Terminal

| Tool | Description |
|------|-------------|
| `terminal_status` | List all windows/tabs/panes in a nested hierarchy, with ids, names/paneIds, dimensions, PIDs, process, and per-pane state. |
| `terminal_run` | Type a command, press Enter, and return the resulting screen (picks CR vs LF per target; refuses shell-backgrounding patterns). Supports `focus`/`raw`. |
| `terminal_keys` | Send raw keystrokes to a pane (`\n` Enter, `\r` Return, `\t` Tab, `\x03` Ctrl-C). Queued while the human is active; `interrupt=true` sends immediately. `attribute=true` prepends a "From: <you>" header for agent panes. |
| `terminal_screen` | Read a pane's current screen as text. Supports `focus`/`raw`. |
| `terminal_scrollback` | Read the last N lines of scrollback history (output that left the visible screen). |
| `terminal_cd` | Change a shell's working directory — applied immediately when idle, queued until the prompt returns when busy. |
| `terminal_split` | Split a pane — a shell by default, or a **web pane** when `url` is set (the only way to put a page beside a terminal in the same tab). Optional startup `command`/`profile`. |
| `terminal_focus` | Focus a pane. Does **not** move the human's view by default — it flashes the target tab (🔔); pass `force:true` to actually pull the view. |
| `terminal_close` | Close a pane. |
| `terminal_rename` | Rename a tab — or a single **pane** when `pane` is given (changes its stable codename; an in-pane agent can rename its own pane, e.g. after a session resume). |
| `terminal_new_tab` | Open a new tab (steals focus), optionally with a startup command/profile. Prefer `terminal_split` for one-offs. |
| `terminal_new_window` | Open a new OS window. |
| `terminal_set_window_size` | Resize a window to an exact content size in pixels (for consistent screenshots). |
| `terminal_where_pane` | Describe the spatial relationship between two panes. |
| `terminal_flush_state` | Flush the current workspace layout (windows/tabs/splits/web panes) to `hyperia.json`. |
| `terminal_ui_key` | Send a keyboard event to the renderer UI layer (Escape, etc.) instead of the PTY. |

## Editing

| Tool | Description |
|------|-------------|
| `apply_text_edits` | Grapheme-safe, transactional range-based file editor (Aegis-Edit). |

## Pulse & liveness (agent coordination)

A **pulse** is a recurring prompt the sidecar re-submits into a pane on its own — independent of any agent's loop — to keep a stalled agent moving. Pulses never steal focus, are idle-gated by default, and auto-expire within an hour. One pulse per pane. Agents self-report liveness so the watchdog can tell real work from a quiet screen.

| Tool | Description |
|------|-------------|
| `pane_pulse_set` | Attach a recurring prompt to a pane. `idle_only` (default true) fires only when the pane looks stalled. Min interval 20s, expires ≤1h, optional `max_fires`. Pulsing a pane you don't own prompts the human; you **cannot** pulse your own pane (use `pane_on_idle`). |
| `pane_pulse_clear` | Clear a pulse **or** a `pane_on_idle` callback — by id (`pulse_N` / `cb_N`) or by pane address (clears everything armed on it). |
| `pane_pulse_pause` | Pause or resume a pulse by id. |
| `pane_pulse_status` | List active pulses (target, interval, `idle_only`, paused, fires, expiry). |
| `pane_on_idle` | Arm a one-shot **self**-poke: when YOUR pane next goes idle, your prompt is delivered back to you. One callback per pane — re-arming **replaces** it (they never stack). Throttled (min 60s between fires; hot re-arm loops get warned, then suspended 1h). Cancel via `pane_pulse_clear` or re-arm with `max_lifetime_secs=1`. |
| `pane_busy` | Self-report this pane is working (`ttl_secs`, default 30 / max 120; re-call to extend) — suppresses pokes and overrides the on-screen heuristic. |
| `pane_idle` | Self-report done — clears busy so the watchdog resumes and armed callbacks may fire. |

## Web panes

| Tool | Description |
|------|-------------|
| `open_web_pane` | Open a URL in its own **separate** web-pane tab (never a split — use `terminal_split` with `url` for side-by-side). Reply includes the new pane's `paneId` — save it and address web_pane_* calls with it (the tab opens in the background, so no-address defaults won't find it). |
| `web_pane_content` | Read the current page as clean reader-mode markdown. |
| `web_pane_eval` | Run JavaScript in a web pane and return the result. |
| `web_pane_mouse` | Move/click at pixel coordinates, with a visible ghost cursor. |
| `terminal_web_click` | Click an element in a web pane. |
| `terminal_web_reload` | Reload a web pane. |

## Sticky notes

| Tool | Description |
|------|-------------|
| `sticky_note_create` | Create a floating note (`text`, optional position/size/color). |
| `sticky_note_create_code` | Open a file-linked code note — syntax-highlighted, live-updates on disk change. |
| `sticky_note_list` | List notes you can see (yours + those the user granted). |
| `sticky_note_read` | Read a note's full text by id. |
| `sticky_note_search` | Full-text (BM25) search across note content. |
| `sticky_note_update` | Edit a note's text (live-updates the open window). |
| `sticky_note_open` | Reopen/raise a note window by id. |
| `sticky_note_close` | Close a note window (keeps the record). |
| `sticky_note_delete` | Permanently delete a note. |
| `sticky_note_schedule` | Schedule a note to fire/run on a timer (survives restart). |

## Output & media

| Tool | Description |
|------|-------------|
| `render` | Render a markdown document (file path or inline) into a new Hyperia tab — supports `==highlight==` markup and live-reloads when the file changes. |
| `hyperia_spoken_summary` | Speak a short summary aloud via fully-local Kokoro TTS, framed as a radio transmission from your callsign. Ungated — the frame is self-attributing. |
| `audio_play` | Play a sound clip on the host speakers (base64 WAV/MP3/FLAC/OGG or raw PCM, max 120s). For speech use `hyperia_spoken_summary`. First use raises a consent prompt (`__audio__` grant, persists per identity); playback is attributed with your callsign; the host can mute. |
| `audio_stream_open` | Consent-check + connection info for CONTINUOUS audio: returns the `ws://…/ws/audio` URL and wire protocol (Bearer auth, one JSON hello `{format, rate, channels}`, then raw PCM binary frames paced to realtime; server reports `{muted}` / `{dropped}`). |

## Snapshots & observability

| Tool | Description |
|------|-------------|
| `tab_snapshot` | Read every pane's screen across all windows/tabs at once. Supports `focus`/`raw`. |
| `tab_image` | Render a schematic image of a tab's pane layout (labeled proportional rectangles). |
| `window_image` | Real-pixels PNG screenshot of an ENTIRE Hyperia window — chrome, terminals, stickies, and native web panes. `window` (id) or focused; `max_width` (default 1200) scales down to save tokens. The way to SEE what the human sees. |
| `shell_state` | Classify panes' states: idle (at prompt), dialog (awaiting selection), running, or empty. |
| `shell_confirm` | Auto-handle common prompts (trust dialogs, y/n confirmations). |
| `shell_log_search` | BM25 search across captured per-shell logs (commands + output history). |
| `agent_status` | Set a pane's agent status light (connected/working/idle + label). |
| `auto_describe` | Use local Ollama to describe what a pane is doing. |
| `sidecar_logs` | Read recent sidecar log output. |
| `hyperia_version` | Report sidecar and Electron app versions. |

## Bugs

| Tool | Description |
|------|-------------|
| `report_bug` | File a Hyperia bug report (title, details, failing tool, exact error, repro context). Use instead of guessing when Hyperia itself misbehaves. |
| `bug_log` | List filed bug reports, newest first. |

## Settings & profiles

| Tool | Description |
|------|-------------|
| `settings_get` | Read a configuration value (dot-path; empty string dumps the config). |
| `settings_set` | Write a configuration value to `~/.hyperia/hyperia.json`. |
| `settings_list_profiles` | List the configured shell profiles. |
| `settings_add_profile` | Add a custom shell profile. |
| `settings_delete_profile` | Remove a profile. |
| `doctor` | Run a readiness report (providers, tokens, services) as structured JSON. |

## Styles

| Tool | Description |
|------|-------------|
| `style_list` | List saved pane styles. |
| `style_create` | Create or clone a reusable pane style. |
| `style_delete` | Delete a style by name. |

## Telemetry

| Tool | Description |
|------|-------------|
| `telemetry_toggle` | Enable/disable telemetry capture. |
| `telemetry_snapshot` | Read current metrics at window or pane level. |
| `telemetry_record` | Record a telemetry event (file op / network / tokens) for a pane. |
| `telemetry_reset` | Clear telemetry counters. |
| `dashboard_widgets` | Configure the dashboard widget layout (`http://localhost:9800/dashboard`). |
