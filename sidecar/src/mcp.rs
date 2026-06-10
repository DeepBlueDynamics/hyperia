use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars,
    service::{RequestContext, RoleServer},
    tool, tool_handler, tool_router,
};

use crate::ghost::compressor::{ContextCompressor, FOCUS_MIN_CHARS};

/// Pull the caller's `Authorization` header off the /mcp request so it can be
/// forwarded on the internal proxy hop to the gated HTTP endpoints. Without
/// this, every MCP mutation tool would reach the HTTP API anonymous and get
/// soft-walled — the consent prompt could never fire. The HTTP request Parts
/// (incl. headers) are injected into the RequestContext extensions by rmcp's
/// streamable-http transport. Absent on the stdio transport → None (anonymous).
fn forwarded_auth(ctx: &RequestContext<RoleServer>) -> Option<String> {
    ctx.extensions
        .get::<axum::http::request::Parts>()
        .and_then(|p| p.headers.get(axum::http::header::AUTHORIZATION))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

// -- Tool request schemas --

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct AuditSearchRequest {
    /// Filter by identity (case-insensitive substring), e.g. "Claude" or a pane prefix.
    pub identity: Option<String>,
    /// Filter by request path substring, e.g. "/api/pane" or "/api/notes".
    pub path: Option<String>,
    /// Filter by exact HTTP status (200 allow, 202 consent, 401 soft-wall, 403 denied).
    pub status: Option<u16>,
    /// Max rows to return (newest first, default 100).
    pub limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct KeysRequest {
    /// Keystrokes to type into the terminal. Use \n for Enter, \t for Tab, \x03 for Ctrl-C (interrupt).
    pub keys: String,
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label / paneId within the tab (DEPRECATED for alphabetical labels like "a", "b"; please use the stable paneId UUID or its 4+ char prefix instead). Omit for first pane.
    pub pane: Option<String>,
    /// Set true to send immediately even when the human is active in this pane — use this to interrupt a running process (e.g. Ctrl-C). When the human is active and this is false/omitted, the keys are queued and you get a notice telling you to resend with interrupt=true.
    pub interrupt: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct RunRequest {
    /// Shell command or text to type
    pub command: String,
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label / paneId within the tab (DEPRECATED for alphabetical labels like "a", "b"; please use the stable paneId UUID or its 4+ char prefix instead). Omit for first pane.
    pub pane: Option<String>,
    /// Milliseconds to wait for output before reading screen (default: 2000)
    pub wait_ms: Option<u64>,
    /// Whether to press Enter after typing the command (default: true). Set false to type text without submitting — lets the human review before pressing Enter.
    pub submit: Option<bool>,
    /// Maximum characters to return from command output (default: 12000). Increase if output is truncated.
    pub max_output_chars: Option<usize>,
    /// What you're looking for in the output — Maximus extracts just that and saves tokens. Example: "exit code", "error messages", "port number".
    pub focus: Option<String>,
    /// Pass true to bypass Maximus and receive the full unfiltered output. A [tokenmax:raw] header confirms the bypass.
    pub raw: Option<bool>,
    /// Acknowledge that you've read the Hyperia anti-pattern warning and intentionally want to run a shell-level backgrounding command (Start-Process, nohup, & at end, tmux). Default false. If false, commands matching those patterns are refused with guidance to use terminal_split / terminal_new_tab instead, which is almost always what you should do in Hyperia.
    pub force: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ScreenRequest {
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label / paneId within the tab (DEPRECATED for alphabetical labels like "a", "b"; please use the stable paneId UUID or its 4+ char prefix instead). Omit for first pane.
    pub pane: Option<String>,
    /// What you're looking for on the screen — Maximus extracts just that. Example: "last error", "current directory", "running process name".
    pub focus: Option<String>,
    /// Pass true to bypass Maximus and receive the full unfiltered output.
    pub raw: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SplitRequest {
    /// Split direction: "horizontal" or "vertical" (default: vertical)
    pub direction: Option<String>,
    /// Shell command to run after the split opens (e.g. "cd /my/project && cargo test")
    pub command: Option<String>,
    /// Shell profile to use for the new split pane. If omitted, uses default shell.
    pub profile: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct FocusRequest {
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label / paneId within the tab (DEPRECATED for alphabetical labels like "a", "b"; please use the stable paneId UUID or its 4+ char prefix instead). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct NewTabRequest {
    /// Shell command to run after the tab opens (e.g. "cd /my/project && claude")
    pub command: Option<String>,
    /// Shell profile to use for the new tab. If omitted, uses default shell.
    pub profile: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct RenameTabRequest {
    /// New name for the tab
    pub name: String,
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Current tab name to rename. Omit for active tab.
    pub tab: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ShellSearchRequest {
    /// Search query (free text; BM25-ranked).
    pub query: String,
    /// Restrict to one shell by its paneId (from terminal_status). Omit to search every shell's log.
    pub pane_id: Option<String>,
    /// Max hits to return (default 20).
    pub limit: Option<usize>,
    /// Number of lines of surrounding context to return around each matching line (optional, defaults to 0).
    pub context_lines: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct StickySearchRequest {
    /// Search query (free text; BM25-ranked over note name + body).
    pub query: String,
    /// Max hits to return (default 20).
    pub limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct StickyScheduleRequest {
    /// Note ID (from sticky_note_list).
    pub id: String,
    /// Trigger: "reminder" (delay+unit), "at" (absolute time), or "cron".
    pub when: Option<String>,
    /// Runner: "notify", "shell", "n8shell", or "n8agent".
    pub runner: Option<String>,
    /// reminder: how many `unit`s from now.
    pub delay: Option<u64>,
    /// reminder unit: "m" (minutes), "h" (hours), or "d" (days).
    pub unit: Option<String>,
    /// "at": ISO-8601 / datetime-local string (e.g. "2026-06-01T19:30").
    pub at: Option<String>,
    /// "cron": 5-field expression (e.g. "*/15 * * * *").
    pub cron: Option<String>,
    /// Working directory for shell/n8shell runners.
    pub dir: Option<String>,
    /// Pass true to clear the schedule and unlock the note.
    pub unschedule: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct TabImageRequest {
    /// Window ID — the `id` field from terminal_status. Omit for focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct OpenWebPaneRequest {
    /// Full URL to open (e.g. "https://localhost:3000" or "https://example.com")
    pub url: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct WebReloadRequest {
    /// Window ID — the `id` field from terminal_status. Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label / paneId within the tab (DEPRECATED for alphabetical labels like "a", "b"; please use the stable paneId UUID or its 4+ char prefix instead). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct WebClickRequest {
    /// Text to find and click on the page (case-insensitive fuzzy match)
    pub text: Option<String>,
    /// CSS selector to click on instead (optional, e.g. "button.login")
    pub selector: Option<String>,
    /// Window ID — the `id` field from terminal_status. Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label / paneId within the tab (DEPRECATED for alphabetical labels like "a", "b"; please use the stable paneId UUID or its 4+ char prefix instead). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct WebEvalRequest {
    /// JavaScript to run in the web pane. The LAST expression's value is returned
    /// (must be JSON-serializable). Return a Promise to await async work.
    pub js: String,
    /// Window ID — the `id` field from terminal_status. Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name. Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label / paneId (DEPRECATED for alphabetical labels like "a", "b"; please use the stable paneId UUID or its 4+ char prefix instead). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct WebMouseRequest {
    /// X coordinate in CSS pixels, relative to the page viewport (left edge = 0).
    pub x: f64,
    /// Y coordinate in CSS pixels, relative to the page viewport (top edge = 0).
    pub y: f64,
    /// "move" (just glide the ghost cursor there) or "click" (glide, then click). Default "move".
    pub action: Option<String>,
    /// Window ID — the `id` field from terminal_status. Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name. Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label / paneId (DEPRECATED for alphabetical labels like "a", "b"; please use the stable paneId UUID or its 4+ char prefix instead). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct StyleCreateRequest {
    /// Name for the new style
    pub name: String,
    /// Clone colors/settings from an existing style name. Omit to start from defaults.
    pub clone_from: Option<String>,
    /// Optional overrides (e.g. {"fontSize": 16, "backgroundColor": "#1a1a2e"})
    pub overrides: Option<serde_json::Value>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct StyleDeleteRequest {
    /// Name of the style to delete
    pub name: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct AgentStatusRequest {
    /// Whether an agent is connected (true = green light, false = grey)
    pub connected: bool,
    /// Whether the agent is actively working (true = red light)
    pub working: Option<bool>,
    /// Short label shown next to the status light (e.g. "Claude working...")
    pub label: Option<String>,
    /// Human interaction percentage (0-100). How much of this session is human-driven.
    pub human_percent: Option<u8>,
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label / paneId within the tab (DEPRECATED for alphabetical labels like "a", "b"; please use the stable paneId UUID or its 4+ char prefix instead). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct UIKeyRequest {
    /// Electron key name: 'Escape', 'c', 'Up', 'Down', 'Return', 'Tab', etc.
    pub key_code: String,
    /// Modifier keys: ['ctrl'], ['alt'], ['shift'], ['meta'], or combinations
    pub modifiers: Option<Vec<String>>,
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SetWindowSizeRequest {
    /// Target content width in pixels.
    pub width: u32,
    /// Target content height in pixels.
    pub height: u32,
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct TelemetryToggleRequest {
    /// Enable or disable telemetry collection
    pub enabled: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct TelemetrySnapshotRequest {
    /// Aggregation level: "window" or "pane"
    pub level: Option<String>,
    /// Pane UID (only used when level is "pane")
    pub pane_uid: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct TelemetryEventRequest {
    /// Pane UID to record the event against
    pub pane_uid: String,
    /// Event JSON (kind: FileOp/Network/Tokens with fields)
    pub event: serde_json::Value,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct DashboardWidgetsRequest {
    /// Array of widget configs to set. Each has: id, kind, title, color, level, visible, order.
    pub widgets: Vec<serde_json::Value>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ShellConfirmRequest {
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label / paneId within the tab (DEPRECATED for alphabetical labels like "a", "b"; please use the stable paneId UUID or its 4+ char prefix instead). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct AutoDescribeRequest {
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label / paneId within the tab (DEPRECATED for alphabetical labels like "a", "b"; please use the stable paneId UUID or its 4+ char prefix instead). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct NoteCreateRequest {
    /// Initial text content for the note (optional)
    pub text: Option<String>,
    /// Background color hex (e.g. "#fff9c4" for yellow). Omit to auto-assign.
    pub color: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct NoteCloseRequest {
    /// Note ID from sticky_note_list output (e.g. "note-1712345678-abc1")
    pub id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct NoteOpenRequest {
    /// Note ID from sticky_note_list output.
    pub id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct WherePaneRequest {
    /// Label of the reference pane (e.g. "a")
    pub a: String,
    /// Label of the pane to locate relative to a (e.g. "b")
    pub b: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct StickyNoteCreateCodeRequest {
    /// Absolute path to the source file on disk
    pub file_path: String,
    /// Code theme: "dark" (default) or "light"
    pub theme: Option<String>,
    /// X position in pixels (optional)
    pub x: Option<i64>,
    /// Y position in pixels (optional)
    pub y: Option<i64>,
    /// Width in pixels (default 800)
    pub width: Option<i64>,
    /// Height in pixels (default 600)
    pub height: Option<i64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct StickyNoteUpdateRequest {
    /// Note ID from sticky_note_list output
    pub id: String,
    /// New text content for the note
    pub text: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct StickyNoteDeleteRequest {
    /// Note ID from sticky_note_list output
    pub id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct StickyNoteReadRequest {
    /// Note ID from sticky_note_list output
    pub id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct TextEditSpec {
    /// 0-based line of the edit start.
    pub start_line: usize,
    /// Start column, counted in extended grapheme clusters (NOT bytes) — emoji/accents are 1 column.
    pub start_col: usize,
    /// 0-based line of the edit end.
    pub end_line: usize,
    /// End column (graphemes). For a pure insert, set end == start.
    pub end_col: usize,
    /// Replacement text for [start, end). Empty string = pure delete.
    pub text: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ApplyEditsRequest {
    /// Absolute path to the UTF-8 text file to edit.
    pub path: String,
    /// One or more DISJOINT edits. Applied transactionally, back-to-front, so earlier
    /// offsets never shift. Overlapping edits are rejected and nothing is written.
    pub edits: Vec<TextEditSpec>,
    /// Pass true to compute the result WITHOUT writing the file (dry run / preview).
    pub preview: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct TabSnapshotRequest {
    /// What you're looking for across all panes — Maximus extracts just that. Example: "error messages", "current git status".
    pub focus: Option<String>,
    /// Pass true to bypass Maximus and receive the full unfiltered snapshot.
    pub raw: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SettingsGetRequest {
    /// Dot-separated path into hyperia.json. Examples: "config.fontSize",
    /// "config.defaultProfile", "config.ferricula.url", "config.profiles".
    /// Pass an empty string to return the whole config object.
    pub path: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SettingsSetRequest {
    /// Dot-separated path into hyperia.json. Intermediate objects are
    /// created if missing. Examples: "config.fontSize",
    /// "config.defaultProfile", "config.ferricula.url".
    pub path: String,
    /// New value to set at that path. Can be a string, number, boolean,
    /// object, or array. Pass null to remove the key.
    pub value: serde_json::Value,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SettingsAddProfileRequest {
    /// Name of the new profile (e.g. "nemesis8"). Must be unique.
    pub name: String,
    /// Executable path (e.g. "/bin/bash" or "C:\\Windows\\System32\\cmd.exe").
    pub shell: String,
    /// Optional arguments for the shell (e.g. ["--login", "-i"]).
    pub shell_args: Option<Vec<String>>,
    /// Optional environment variables (e.g. {"FOO": "BAR"}).
    pub env: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SettingsDeleteProfileRequest {
    /// Name of the profile to delete.
    pub name: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct FlushRequest {}

// -- MCP Server --

#[derive(Clone)]
pub struct HyperiaMcp {
    tool_router: ToolRouter<Self>,
    client: reqwest::Client,
    base_url: String,
    compressor: ContextCompressor,
}

#[tool_router]
impl HyperiaMcp {
    pub fn new(http_port: u16) -> Self {
        let base_url = std::env::var("HYPERIA_BASE_URL")
            .ok()
            .map(|value| value.trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("http://127.0.0.1:{}", http_port));
        Self {
            tool_router: Self::tool_router(),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            base_url,
            compressor: ContextCompressor::from_env(),
        }
    }

    /// Apply Maximus to a tool result string. Returns annotated content.
    async fn maximus_filter(&self, text: &str, focus: Option<&str>, raw: bool) -> String {
        let focus = focus.unwrap_or("").trim();
        let focus_used = !focus.is_empty();
        if !raw && !focus_used && text.len() < FOCUS_MIN_CHARS {
            return text.to_string();
        }
        let mr = self.compressor.extract_maximus(text, focus, raw).await;
        let annotation = ContextCompressor::format_annotation(&mr.meta, focus_used, raw);
        if annotation.is_empty() {
            mr.content
        } else {
            format!("{}{}", annotation, mr.content)
        }
    }

    // -- Runtime-feedback helpers shared by terminal_run and terminal_keys --
    //
    // The point: when a tool call doesn't behave the way the agent expected,
    // the RESPONSE itself should explain what happened in actionable terms.
    // Static tool descriptions are read once at registration; the only thing
    // the calling agent sees on every call is what comes back. So we attach a
    // small diagnostic envelope when something interesting happens (silent
    // wait, unsubmitted-looking input buffer, known-TUI target, etc.).

    /// Look up the foreground process name for the target pane via /api/status.
    /// Returns "" if we can't resolve.
    async fn pane_process_name(
        &self,
        window: Option<u32>,
        tab: Option<&str>,
        pane: Option<&str>,
    ) -> String {
        let Ok(status_text) = self.get("/api/status").await else { return String::new(); };
        let Ok(status): Result<serde_json::Value, _> = serde_json::from_str(&status_text) else { return String::new(); };
        let windows = status["windows"].as_array().cloned().unwrap_or_default();
        let win_obj = if let Some(wid) = window {
            windows.iter().find(|w| w["id"].as_u64() == Some(wid as u64)).cloned()
        } else {
            windows.iter().find(|w| w["focused"].as_bool() == Some(true)).cloned()
                .or_else(|| windows.first().cloned())
        };
        let Some(win_obj) = win_obj else { return String::new(); };
        let tabs = win_obj["tabs"].as_array().cloned().unwrap_or_default();
        let tab_obj = if let Some(tname) = tab {
            tabs.iter().find(|t| t["name"].as_str() == Some(tname)).cloned()
        } else {
            tabs.iter().find(|t| t["active"].as_bool() == Some(true)).cloned()
                .or_else(|| tabs.first().cloned())
        };
        let Some(tab_obj) = tab_obj else { return String::new(); };
        let panes_arr = tab_obj["panes"].as_array().cloned().unwrap_or_default();
        let pane_obj = if let Some(p) = pane {
            // Try label match first, then paneId (or paneId prefix).
            panes_arr.iter().find(|x| x["label"].as_str() == Some(p))
                .or_else(|| panes_arr.iter().find(|x| {
                    x["paneId"].as_str().map(|pid| pid.starts_with(p)).unwrap_or(false)
                }))
                .cloned()
        } else {
            panes_arr.iter().find(|x| x["active"].as_bool() == Some(true)).cloned()
                .or_else(|| panes_arr.first().cloned())
        };
        let Some(pane_obj) = pane_obj else { return String::new(); };
        pane_obj["process"].as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| pane_obj["shell"].as_str())
            .unwrap_or("")
            .to_string()
    }

    /// True if `proc_name` looks like an Ink/Node TUI agent (claude code, codex,
    /// aider, gemini-cli, etc.) — these listen for LF (\n), not CR (\r), for
    /// submit, and silently absorb a bare CR. Used to attach a clear hint when
    /// terminal_run's output came back empty.
    fn is_likely_ink_tui(proc_name: &str) -> bool {
        let n = proc_name.to_lowercase();
        // Node-ish runtime + known agent CLI binaries that wrap it.
        ["node", "claude", "claude-code", "codex", "aider", "gemini", "ollama"]
            .iter()
            .any(|needle| n.contains(needle))
    }

    /// Read the current screen tail and return whether it appears to still hold
    /// the (unsubmitted) command text. Best-effort heuristic — used as a
    /// secondary signal alongside "did we receive any new output?".
    async fn screen_likely_holds_unsubmitted(
        &self,
        window: Option<u32>,
        tab: Option<&str>,
        pane: Option<&str>,
        cmd: &str,
    ) -> bool {
        let needle = cmd.trim();
        if needle.is_empty() { return false; }
        // Use the last 40 chars of the command — multi-line / wrapped inputs
        // won't appear verbatim, but the tail almost always does.
        let chars: Vec<char> = needle.chars().collect();
        let tail: String = chars.iter().rev().take(40).rev().collect();
        let screen_path = self.pane_path("/api/screen", window, tab, pane);
        let Ok(screen) = self.get(&screen_path).await else { return false; };
        // Look at the last ~5 non-empty lines.
        let last: String = screen
            .lines()
            .rev()
            .filter(|l| !l.trim().is_empty())
            .take(5)
            .collect::<Vec<_>>()
            .join("\n");
        last.contains(tail.trim())
    }

    /// Build the human-readable diagnostic line(s) to append to a tool's
    /// returned text. Empty string when nothing notable happened. The shape is
    /// intentionally a single tagged line so agents can grep `[hyperia:meta]`
    /// to extract it.
    fn build_run_diagnostic(
        target_process: &str,
        wait_ms: u64,
        quiet_silent: bool,
        screen_held_input: bool,
        cmd_summary: &str,
    ) -> String {
        // Happy path: target produced output. Nothing to say.
        if !quiet_silent && !screen_held_input { return String::new(); }
        let mut lines = vec![format!(
            "[hyperia:meta] target_process={} wait_ms={} quiet_silent={} screen_held_input={}",
            if target_process.is_empty() { "?" } else { target_process },
            wait_ms,
            quiet_silent,
            screen_held_input,
        )];
        if screen_held_input {
            lines.push(format!(
                "[hyperia:hint] Your input appears to still be sitting in the target's input buffer ({}…). The submit byte was not accepted as Enter by this process. To submit it now, call terminal_keys with keys=\"\\n\" (LF) against this same pane.",
                crate::util::safe_prefix(&cmd_summary, 50),
            ));
        } else if quiet_silent {
            lines.push(format!(
                "[hyperia:hint] No output observed within {}ms. Either the command was silent (e.g. `cd`) and worked, or the target didn't process your input. Confirm with terminal_screen.",
                wait_ms,
            ));
        }
        if Self::is_likely_ink_tui(target_process) {
            lines.push(format!(
                "[hyperia:hint] target_process='{}' is a Node/Ink TUI agent (claude-code, codex, aider, gemini-cli). terminal_run detects these and submits with LF (\\n); if input still didn't take, follow up with terminal_keys keys=\"\\n\".",
                target_process,
            ));
        }
        lines.join("\n")
    }

    #[tool(description = "Type keystrokes into a terminal pane. Use \\n for Enter, \\r for Return, \\t for Tab, \\x03 for Ctrl-C. These are unescaped automatically. Address panes with window/tab/pane. The pane field accepts either a pane label or the paneId from terminal_status; if the label is empty, use paneId. If the human is currently active in the target pane, the keys are queued and the reply tells you so — resend with interrupt=true to send immediately (use this to interrupt a running process). The response includes a [hyperia:meta] envelope describing the target process so you can detect Ink/TUI agents that need LF (\\n) instead of CR (\\r) for submit.")]
    async fn terminal_keys(
        &self,
        Parameters(req): Parameters<KeysRequest>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.focus_pane(req.window, req.tab.as_deref(), req.pane.as_deref()).await;
        let mut path = self.pane_path("/api/type", req.window, req.tab.as_deref(), req.pane.as_deref());
        if req.interrupt.unwrap_or(false) {
            let sep = if path.contains('?') { '&' } else { '?' };
            path.push(sep);
            path.push_str("interrupt=true");
        }
        let resp = self.post_text_as(&path, &req.keys, None, forwarded_auth(&ctx).as_deref()).await?;
        let target_process = self.pane_process_name(req.window, req.tab.as_deref(), req.pane.as_deref()).await;
        let mut out = resp;
        if !target_process.is_empty() {
            let extra = format!("\n[hyperia:meta] target_process={}", target_process);
            out.push_str(&extra);
            if Self::is_likely_ink_tui(&target_process) {
                out.push_str(&format!(
                    "\n[hyperia:hint] target_process='{}' is a Node/Ink TUI — it reads LF for submit. If your keys contained \\r and the target didn't react, retry with keys=\"\\n\".",
                    target_process,
                ));
            }
        }
        Ok(CallToolResult::success(vec![Content::text(out)]))
    }

    #[tool(description = "Type text into a terminal pane and press Enter. Works for shell commands and interactive programs (Codex, Python REPL, vim, etc.). Picks the submit byte per target: CR for shells (PowerShell, bash, cmd), LF for Node/Ink TUI agents (claude-code, codex, aider, gemini-cli) — so neither a phantom continuation prompt nor a silently-absorbed Enter occurs. Set submit=false to type without pressing Enter — useful to let the human review before submitting. Pass focus= to receive only the relevant part of the output — Maximus filters the result so you only see what you asked for. Pass raw=true to bypass Maximus and see the full output. Refuses shell-level backgrounding patterns (Start-Process, nohup, & at end, tmux) and points you to terminal_split / terminal_new_tab; set force=true to bypass. The response includes a [hyperia:meta] envelope when the target didn't appear to respond — telling you whether the input is still sitting unsubmitted and what to do next.")]
    async fn terminal_run(
        &self,
        Parameters(req): Parameters<RunRequest>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.focus_pane(req.window, req.tab.as_deref(), req.pane.as_deref()).await;
        let submit = req.submit.unwrap_or(true);
        let wait = req.wait_ms.unwrap_or(if submit { 2000 } else { 200 });
        let cmd = strip_trailing_returns(&req.command).to_string();

        // Anti-pattern guardrail. Hyperia is a multi-pane terminal — agents
        // should split a pane or open a new tab to host long-running tasks
        // (servers, watchers, REPLs) instead of using shell-level
        // backgrounding hacks. We bounce the common offenders with a clear
        // message; the agent can set force=true to override.
        if !req.force.unwrap_or(false) {
            if let Some(pat) = looks_like_background_hack(&cmd) {
                return Ok(CallToolResult::success(vec![Content::text(format!(
                    "REFUSED ({pat}). Hyperia gives you unlimited panes — don't background processes with shell hacks. Instead:\n  1. terminal_split (or terminal_new_tab) to create a fresh pane\n  2. terminal_run your long-running command in that new pane (it stays visible, the human can see it, you can read its output any time with terminal_screen)\nIf you genuinely need shell backgrounding and not a Hyperia pane, resend with force=true."
                ))]));
            }
        }

        // Resolve the foreground process up front so we can pick the correct
        // submit byte per target. Shells (pwsh, bash, cmd) take CR (`\r`) as
        // Enter and treat a trailing LF as a continuation line (PowerShell
        // shows a phantom `>>`). Node/Ink TUI agents (claude-code, codex,
        // aider, gemini-cli) take LF (`\n`) and silently absorb a bare CR.
        // There is no single byte that satisfies both — so we choose.
        let target_process = self
            .pane_process_name(req.window, req.tab.as_deref(), req.pane.as_deref())
            .await;
        let submit_seq = if Self::is_likely_ink_tui(&target_process) { "\n" } else { "\r" };

        if submit {
            // Use type-and-collect: sends the command, streams all PTY output until
            // wait_ms of silence (up to 8s hard cap). Returns full output, not just
            // the visible screen — avoids silent truncation of long command output.
            // raw=true on the server side bypasses unescape_keys so Windows paths
            // like `\research` aren't shredded into a CR + `esearch`.
            let base = self.pane_path("/api/type-and-collect", req.window, req.tab.as_deref(), req.pane.as_deref());
            let sep = if base.contains('?') { '&' } else { '?' };
            let collect_path = format!("{}{sep}quiet_ms={}&raw=true", base, wait);
            // Give the HTTP client headroom over the server's quiet window so it doesn't
            // time out before /api/type-and-collect finishes draining PTY output.
            let req_timeout = std::time::Duration::from_millis(wait + 15_000);
            let raw_output = self
                .post_text_as(
                    &collect_path,
                    &format!("{}{}", cmd, submit_seq),
                    Some(req_timeout),
                    forwarded_auth(&ctx).as_deref(),
                )
                .await?;
            let max_chars = req.max_output_chars.unwrap_or(12_000);
            let text = clean_terminal_output(&raw_output, max_chars);
            let mut out = self.maximus_filter(&text, req.focus.as_deref(), req.raw.unwrap_or(false)).await;

            // --- Runtime feedback envelope ---
            // The trimmed text (after Maximus + cleaning) is what the agent
            // actually saw. If it's empty / pure whitespace AND the target's
            // last screen lines still hold our command tail, the input never
            // made it past the target's input buffer.
            let trimmed_visible = text.trim();
            let quiet_silent = trimmed_visible.is_empty();
            let screen_held_input = if quiet_silent {
                self.screen_likely_holds_unsubmitted(
                    req.window, req.tab.as_deref(), req.pane.as_deref(), &cmd,
                ).await
            } else {
                false
            };
            let diag = Self::build_run_diagnostic(
                &target_process, wait, quiet_silent, screen_held_input, &cmd,
            );
            if !diag.is_empty() {
                if !out.is_empty() && !out.ends_with('\n') { out.push('\n'); }
                out.push_str(&diag);
            }
            Ok(CallToolResult::success(vec![Content::text(out)]))
        } else {
            // submit=false: just type the text without waiting for output. raw=true
            // for the same reason — preserve Windows backslash-paths verbatim.
            let base = self.pane_path("/api/type", req.window, req.tab.as_deref(), req.pane.as_deref());
            let sep = if base.contains('?') { '&' } else { '?' };
            let pane_path = format!("{}{sep}raw=true", base);
            self.post_text(&pane_path, &cmd).await?;
            Ok(CallToolResult::success(vec![Content::text(String::from("Typed (not submitted). Press Enter to run."))]))
        }
    }

    #[tool(description = "Read the current screen content of a terminal pane. Address panes with window/tab/pane. The pane field accepts either a pane label or the paneId from terminal_status; if the label is empty, use paneId. Pass focus= to receive only the relevant part — Maximus filters the output. Pass raw=true to bypass Maximus.")]
    async fn terminal_screen(
        &self,
        Parameters(req): Parameters<ScreenRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let text = self.get(&self.pane_path("/api/screen", req.window, req.tab.as_deref(), req.pane.as_deref())).await?;
        let out = self.maximus_filter(&text, req.focus.as_deref(), req.raw.unwrap_or(false)).await;
        Ok(CallToolResult::success(vec![Content::text(out)]))
    }

    #[tool(description = "List all open windows, tabs, and panes in a nested hierarchy. Each window has an `id` field — pass that exact value as the `window` parameter in other tools (it is NOT 0-based; the first window is typically id=1). Each pane includes both a label (DEPRECATED; do not use as it shifts when splits are added/removed) and a paneId. When addressing a pane in other tools, always use the stable paneId or its 4+ character prefix instead of the label.")]
    async fn terminal_status(&self) -> Result<CallToolResult, ErrorData> {
        let text = self.get("/api/status").await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    #[tool(description = "Render a black-and-white schematic image of a tab's pane layout — proportional rectangles for every split, labeled with pane letter, kind, title, and cwd. Returns the PNG as inline image content (multimodal agents can view it directly) plus the saved file path on disk under ~/.hyperia/snapshots/. Much faster to grok than walking terminal_status JSON when you just need to orient yourself. Omit window/tab for the active tab.")]
    async fn tab_image(
        &self,
        Parameters(req): Parameters<TabImageRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        // Pull /api/status, then either filter to requested window/tab or pick
        // the focused one. We assemble a flat list of PaneCells for the
        // renderer.
        let status_text = self.get("/api/status").await?;
        let status: serde_json::Value = serde_json::from_str(&status_text)
            .map_err(|e| ErrorData::internal_error(format!("status parse: {e}"), None))?;
        let windows = status["windows"].as_array().cloned().unwrap_or_default();
        if windows.is_empty() {
            return Ok(CallToolResult::success(vec![Content::text(
                "(no windows open)".to_string(),
            )]));
        }
        // Window selection
        let win = if let Some(wid) = req.window {
            windows
                .iter()
                .find(|w| w["id"].as_u64() == Some(wid as u64))
                .cloned()
        } else {
            // First focused; else first window.
            windows
                .iter()
                .find(|w| w["focused"].as_bool() == Some(true))
                .cloned()
                .or_else(|| windows.first().cloned())
        };
        let win = win.ok_or_else(|| {
            ErrorData::invalid_params(
                format!("No matching window (asked window={:?})", req.window),
                None,
            )
        })?;
        let tabs = win["tabs"].as_array().cloned().unwrap_or_default();
        let tab = if let Some(name) = req.tab.as_deref() {
            tabs.iter()
                .find(|t| t["name"].as_str() == Some(name))
                .cloned()
        } else {
            tabs.iter()
                .find(|t| t["active"].as_bool() == Some(true))
                .cloned()
                .or_else(|| tabs.first().cloned())
        };
        let tab = tab.ok_or_else(|| {
            ErrorData::invalid_params(
                format!("No matching tab (window={:?} tab={:?})", req.window, req.tab),
                None,
            )
        })?;
        let tab_name = tab["name"].as_str().unwrap_or("(untitled)").to_string();
        let panes_json = tab["panes"].as_array().cloned().unwrap_or_default();
        // Convert JSON panes into PaneCell.
        let mut cells: Vec<crate::snapshot_image::PaneCell> = Vec::with_capacity(panes_json.len());
        // Borrow strings — collect owned then borrow on the fly.
        struct Owned {
            label: String,
            kind: String,
            title: String,
            subtitle: String,
            bsp_x: f32,
            bsp_y: f32,
            bsp_w: f32,
            bsp_h: f32,
        }
        let owned: Vec<Owned> = panes_json
            .iter()
            .map(|p| Owned {
                label: p["label"].as_str().unwrap_or("").to_string(),
                kind: if p["webUrl"].is_string() { "web".into() } else { "shell".into() },
                title: p["title"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| p["process"].as_str().filter(|s| !s.is_empty()))
                    .or_else(|| p["shell"].as_str())
                    .or_else(|| p["webUrl"].as_str())
                    .unwrap_or("")
                    .to_string(),
                subtitle: p["cwd"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| p["webUrl"].as_str())
                    .unwrap_or("")
                    .to_string(),
                bsp_x: p["bspX"].as_f64().unwrap_or(0.0) as f32,
                bsp_y: p["bspY"].as_f64().unwrap_or(0.0) as f32,
                bsp_w: p["bspW"].as_f64().unwrap_or(0.0) as f32,
                bsp_h: p["bspH"].as_f64().unwrap_or(0.0) as f32,
            })
            .collect();
        for o in &owned {
            cells.push(crate::snapshot_image::PaneCell {
                label: &o.label,
                kind: &o.kind,
                title: &o.title,
                subtitle: &o.subtitle,
                bsp_x: o.bsp_x,
                bsp_y: o.bsp_y,
                bsp_w: o.bsp_w,
                bsp_h: o.bsp_h,
            });
        }

        let png_bytes = crate::snapshot_image::render_tab_png(&tab_name, &cells);

        // Save to ~/.hyperia/snapshots/<sanitized>-<8charwin>.png. Overwrites
        // the previous snapshot for the same tab on every call.
        let home = std::env::var("USERPROFILE")
            .ok()
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| ".".into());
        let dir = std::path::PathBuf::from(home).join(".hyperia").join("snapshots");
        let _ = std::fs::create_dir_all(&dir);
        let safe_name: String = tab_name
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect();
        let win_id = win["id"].as_u64().unwrap_or(0);
        let filename = format!("w{}-{}.png", win_id, safe_name);
        let path = dir.join(&filename);
        let _ = std::fs::write(&path, &png_bytes);

        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
        Ok(CallToolResult::success(vec![
            Content::image(b64, "image/png".to_string()),
            Content::text(format!(
                "Saved to: {}\n({} panes, {} bytes)",
                path.display(),
                cells.len(),
                png_bytes.len()
            )),
        ]))
    }

    #[tool(description = "Flush and save the current workspace layout state (windows, tabs, splits, terminal panes, and web panes) to the hyperia.json config file. The saved state can be resumed automatically upon the next launch of Hyperia or edited by other external tools.")]
    async fn terminal_flush_state(
        &self,
        Parameters(req): Parameters<FlushRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let resp = self.post_text("/api/layout/save", "").await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Split the currently focused pane into two. Returns the new pane's stable paneId UUID. Direction: 'horizontal' (top/bottom) or 'vertical' (left/right, default). You can optionally provide a startup command to run in the new split pane, and specify a shell profile. If no profile is specified, it defaults to the 'default' shell profile.")]
    async fn terminal_split(
        &self,
        Parameters(req): Parameters<SplitRequest>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({
            "direction": req.direction.unwrap_or_else(|| "vertical".into()),
            "command": req.command,
            "profile": req.profile,
        });
        let resp = self.post_json_as("/api/pane/split", &body, forwarded_auth(&ctx).as_deref()).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Focus a specific pane by window/tab/pane address. The pane field accepts either a pane label or the paneId from terminal_status; if the label is empty, use paneId.")]
    async fn terminal_focus(
        &self,
        Parameters(req): Parameters<FocusRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"window": req.window, "tab": req.tab, "pane": req.pane});
        let resp = self.post_json("/api/pane/focus", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Close the currently focused pane.")]
    async fn terminal_close(&self, ctx: RequestContext<RoleServer>) -> Result<CallToolResult, ErrorData> {
        let resp = self
            .post_json_as("/api/pane/close", &serde_json::json!({}), forwarded_auth(&ctx).as_deref())
            .await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Rename a tab. Changes the display name that appears in the tab bar and in terminal_status.")]
    async fn terminal_rename(
        &self,
        Parameters(req): Parameters<RenameTabRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"window": req.window, "tab": req.tab, "name": req.name});
        let resp = self.post_json("/api/pane/rename", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Describe the spatial relationship between two split panes — e.g. 'pane b is below and to the right of pane a'. Pass pane identifiers from terminal_status. Use pane labels when present; otherwise use paneId.")]
    async fn terminal_where_pane(
        &self,
        Parameters(req): Parameters<WherePaneRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let resp = self.get(&format!("/api/pane/where?a={}&b={}", req.a, req.b)).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Open a new tab. Returns the new tab's root pane stable paneId UUID. Optionally specify a startup command to run in it and a shell profile. If no profile is specified, it uses default shell.")]
    async fn terminal_new_tab(
        &self,
        Parameters(req): Parameters<NewTabRequest>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut body = serde_json::json!({});
        if let Some(cmd) = &req.command {
            body["command"] = serde_json::json!(cmd);
        }
        if let Some(prof) = &req.profile {
            body["profile"] = serde_json::json!(prof);
        }
        let resp = self.post_json_as("/api/pane/new", &body, forwarded_auth(&ctx).as_deref()).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Open a new Hyperia OS window (separate from the current window). Use terminal_status after to get its window `id` for targeting other tools. Use when the user wants a separate window, not just a new tab.")]
    async fn terminal_new_window(&self, ctx: RequestContext<RoleServer>) -> Result<CallToolResult, ErrorData> {
        let resp = self
            .post_json_as("/api/window/new", &serde_json::json!({}), forwarded_auth(&ctx).as_deref())
            .await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(
        description = "Resize a Hyperia window to an exact content size in pixels — use this to get consistent screenshots (set the size, then call tab_image). Pass width and height; pass window (the id from terminal_status) to target a specific window, or omit it to resize the focused window. Returns the resulting {width, height}. Agent-only capability — there is no user-facing control for it."
    )]
    async fn terminal_set_window_size(
        &self,
        Parameters(req): Parameters<SetWindowSizeRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({
            "window": req.window,
            "width": req.width,
            "height": req.height,
        });
        let resp = self.post_json("/api/window/size", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Open a URL in a new dedicated web pane tab inside Hyperia. Opens an embedded browser tab alongside your terminal tabs — does NOT replace or overlay any existing terminal. Pass a full URL (https://...). Use this to show docs, dashboards, localhost servers, or any web content.")]
    async fn open_web_pane(
        &self,
        Parameters(req): Parameters<OpenWebPaneRequest>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let resp = self
            .post_json_as("/api/web-pane", &serde_json::json!({"url": req.url}), forwarded_auth(&ctx).as_deref())
            .await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Reload a web pane browser page. Address panes with window/tab/pane. The pane field accepts either a pane label or the paneId from terminal_status.")]
    async fn terminal_web_reload(
        &self,
        Parameters(req): Parameters<WebReloadRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let path = self.pane_path("/api/web-pane/reload", req.window, req.tab.as_deref(), req.pane.as_deref());
        let resp = self.post_text(&path, "").await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Click an element inside a web pane page. You can specify a text query (fuzzy case-insensitive match e.g. 'log in') or a CSS selector (e.g. 'button.submit'). Address panes with window/tab/pane.")]
    async fn terminal_web_click(
        &self,
        Parameters(req): Parameters<WebClickRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let path = self.pane_path("/api/web-pane/click", req.window, req.tab.as_deref(), req.pane.as_deref());
        let body = serde_json::json!({
            "text": req.text,
            "selector": req.selector,
        });
        let resp = self.post_json(&path, &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Read the CURRENT page of a web pane as clean reader-mode MARKDOWN. Returns JSON {success, url, title, markdown}: `url` is the LIVE location.href (the opened URL in terminal_status goes stale after the user navigates — this is the real one), `title` is document.title, `markdown` is the page's main content converted from the ALREADY-RENDERED DOM (post-JS, logged-in/cookie state applied) by grub's converter — nav/footer/ads stripped. Strictly better than re-crawling the URL, which would re-fetch a possibly bot-blocked or logged-out version. Use this to see what page the user is on and extract its content (recipe, article, docs, search results). Address panes with window/tab/pane.")]
    async fn web_pane_content(
        &self,
        Parameters(req): Parameters<WebReloadRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let path = self.pane_path("/api/web-pane/content", req.window, req.tab.as_deref(), req.pane.as_deref());
        let resp = self.post_text(&path, "").await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Run arbitrary JavaScript inside a web pane and return its result. The code runs in the page's context (full DOM access), with a user-gesture so gesture-gated APIs work. The value of the LAST expression is returned as JSON {success, value}; return a Promise to await async work. Use this to scrape structured data, fill forms, read computed state, drive a SPA — anything the page's own JS could do. Address panes with window/tab/pane.")]
    async fn web_pane_eval(
        &self,
        Parameters(req): Parameters<WebEvalRequest>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let path = self.pane_path("/api/web-pane/eval", req.window, req.tab.as_deref(), req.pane.as_deref());
        let resp = self
            .post_json_as(&path, &serde_json::json!({"js": req.js}), forwarded_auth(&ctx).as_deref())
            .await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Move or click at a pixel coordinate in a web pane, with a 👻 ghost cursor that visibly GLIDES to the spot so the human can watch you act. action='move' just glides the ghost there; action='click' glides then fires the full pointer/mouse event sequence on the element at (x,y). Coordinates are CSS pixels from the top-left of the page viewport (use web_pane_content / web_pane_eval with getBoundingClientRect to find them). Returns JSON {success, action, x, y, target, text}. Address panes with window/tab/pane.")]
    async fn web_pane_mouse(
        &self,
        Parameters(req): Parameters<WebMouseRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let path = self.pane_path("/api/web-pane/mouse", req.window, req.tab.as_deref(), req.pane.as_deref());
        let body = serde_json::json!({
            "x": req.x,
            "y": req.y,
            "action": req.action.unwrap_or_else(|| "move".into()),
        });
        let resp = self.post_json(&path, &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Read sidecar logs.")]
    async fn sidecar_logs(&self) -> Result<CallToolResult, ErrorData> {
        let text = self.get("/api/logs").await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    #[tool(description = "Search the Hyperia audit log — who did what, when, and the decision. Every gated/identified call is recorded {ts, identity, action (method+path), status}. Filter by identity (substring), path (substring), status code, and limit. Read-only.")]
    async fn audit_search(
        &self,
        Parameters(req): Parameters<AuditSearchRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut q: Vec<String> = Vec::new();
        if let Some(i) = &req.identity {
            q.push(format!("identity={}", urlencoding::encode(i)));
        }
        if let Some(p) = &req.path {
            q.push(format!("path={}", urlencoding::encode(p)));
        }
        if let Some(s) = req.status {
            q.push(format!("status={s}"));
        }
        if let Some(l) = req.limit {
            q.push(format!("limit={l}"));
        }
        let path = if q.is_empty() {
            "/api/audit/search".to_string()
        } else {
            format!("/api/audit/search?{}", q.join("&"))
        };
        let resp = self.get(&path).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Get the current Hyperia version. Returns the sidecar version and the Electron app version.")]
    async fn hyperia_version(&self) -> Result<CallToolResult, ErrorData> {
        let sidecar_version = env!("CARGO_PKG_VERSION");
        let app_version = match self.get("/api/status").await {
            Ok(status) => {
                serde_json::from_str::<serde_json::Value>(&status)
                    .ok()
                    .and_then(|v| v["version"].as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown".into())
            }
            Err(_) => "unavailable (sidecar not connected to Electron)".into(),
        };
        let info = format!(
            "Hyperia v{}\nSidecar v{}\nElectron app v{}",
            sidecar_version, sidecar_version, app_version
        );
        Ok(CallToolResult::success(vec![Content::text(info)]))
    }

    #[tool(
        description = "List Hyperia's higher-level skills: named capability areas (terminal orchestration, web panes, sticky notes, snapshots, settings, file editing, styles, telemetry, diagnostics) and the MCP tools that perform each. Call this to discover what Hyperia can do and which tools to combine for a task, instead of inferring from the flat tool list. No inputs. Returns a JSON array of {name, description, tools}."
    )]
    async fn skills(&self) -> Result<CallToolResult, ErrorData> {
        let skills = serde_json::json!([
            {
                "name": "terminal",
                "description": "Drive terminal panes: open windows/tabs, split panes, run commands, read screens, and send keystrokes. Hyperia gives unlimited visible panes — prefer a dedicated pane over shell backgrounding.",
                "tools": ["terminal_status", "terminal_new_tab", "terminal_new_window", "terminal_split", "terminal_run", "terminal_keys", "terminal_screen", "terminal_focus", "terminal_rename", "terminal_close"]
            },
            {
                "name": "web",
                "description": "Open and operate embedded web panes: navigate to a URL, read rendered page content, click, move the mouse, and evaluate JS in the page.",
                "tools": ["open_web_pane", "web_pane_content", "web_pane_eval", "web_pane_mouse", "terminal_web_click", "terminal_web_reload"]
            },
            {
                "name": "stickies",
                "description": "Create and manage floating sticky notes, including file-linked code notes with syntax highlighting. Search, read, update, schedule, reopen, and close them.",
                "tools": ["sticky_note_create", "sticky_note_create_code", "sticky_note_list", "sticky_note_search", "sticky_note_read", "sticky_note_update", "sticky_note_open", "sticky_note_close", "sticky_note_delete", "sticky_note_schedule"]
            },
            {
                "name": "snapshots",
                "description": "Capture the state of the workspace as text or image: a whole tab's panes, a single pane's screen, or a screenshot, plus where a pane lives.",
                "tools": ["tab_snapshot", "tab_image", "terminal_screen", "terminal_where_pane"]
            },
            {
                "name": "settings",
                "description": "Inspect and change Hyperia configuration and shell profiles, and run a readiness check.",
                "tools": ["settings_get", "settings_set", "settings_list_profiles", "settings_add_profile", "settings_delete_profile", "doctor"]
            },
            {
                "name": "editing",
                "description": "Apply structured, range-based text edits to files on disk.",
                "tools": ["apply_text_edits"]
            },
            {
                "name": "styles",
                "description": "Create, list, and delete reusable visual styles for panes.",
                "tools": ["style_list", "style_create", "style_delete"]
            },
            {
                "name": "telemetry",
                "description": "Per-pane metrics and the live dashboard. Toggle capture, snapshot current metrics, record events, and reset.",
                "tools": ["telemetry_toggle", "telemetry_snapshot", "telemetry_record", "telemetry_reset", "dashboard_widgets"]
            },
            {
                "name": "diagnostics",
                "description": "Inspect Hyperia itself: version, agent status, sidecar logs, shell log search, shell state, and auto-describe a pane.",
                "tools": ["hyperia_version", "agent_status", "auto_describe", "sidecar_logs", "shell_log_search", "shell_state"]
            }
        ]);
        let out = serde_json::to_string_pretty(&skills).unwrap_or_else(|_| "[]".to_string());
        Ok(CallToolResult::success(vec![Content::text(out)]))
    }

    #[tool(description = "Send a keyboard event directly to a Hyperia window's UI layer — bypasses the PTY and hits React/Electron's event system. Use this to send keys like Escape, Ctrl+C, Alt+Up that are handled as UI shortcuts rather than terminal input. keyCode uses Electron key names (e.g. 'Escape', 'c', 'Up'). modifiers is an array like ['ctrl'], ['alt'], ['shift'], ['ctrl','shift'].")]
    async fn terminal_ui_key(
        &self,
        Parameters(req): Parameters<UIKeyRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut body = serde_json::json!({
            "keyCode": req.key_code,
            "modifiers": req.modifiers.unwrap_or_default(),
        });
        if let Some(w) = req.window {
            body["windowId"] = serde_json::json!(w);
        }
        let resp = self
            .post_json("/api/ui/key", &body)
            .await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Set the agent status light on a specific pane. Address with window/tab/pane.")]
    async fn agent_status(
        &self,
        Parameters(req): Parameters<AgentStatusRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({
            "connected": req.connected,
            "working": req.working,
            "label": req.label,
            "humanPercent": req.human_percent,
            "window": req.window,
            "tab": req.tab,
            "pane": req.pane,
        });
        let resp = self.post_json("/api/agent/status", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "List all styles in the Hyperia config.")]
    async fn style_list(&self) -> Result<CallToolResult, ErrorData> {
        let cfg = self.read_config().await?;
        let styles = cfg["config"]["styles"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let names: Vec<String> = styles
            .iter()
            .filter_map(|s| s["name"].as_str().map(|n| n.to_string()))
            .collect();
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&names).unwrap(),
        )]))
    }

    #[tool(description = "Create or clone a style. Optionally clone from an existing style and apply overrides.")]
    async fn style_create(
        &self,
        Parameters(req): Parameters<StyleCreateRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut cfg = self.read_config().await?;
        let styles = cfg["config"]["styles"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        if styles.iter().any(|s| s["name"].as_str() == Some(&req.name)) {
            return Ok(CallToolResult::success(vec![Content::text(
                format!("Style '{}' already exists", req.name),
            )]));
        }

        let mut config = if let Some(ref source) = req.clone_from {
            styles
                .iter()
                .find(|s| s["name"].as_str() == Some(source))
                .and_then(|s| s["config"].as_object().cloned())
                .unwrap_or_default()
        } else {
            serde_json::Map::new()
        };

        if let Some(overrides) = req.overrides {
            if let Some(obj) = overrides.as_object() {
                for (k, v) in obj {
                    config.insert(k.clone(), v.clone());
                }
            }
        }

        let new_style = serde_json::json!({
            "name": req.name,
            "config": config,
        });

        // Ensure styles array exists
        if cfg["config"]["styles"].is_null() {
            cfg["config"]["styles"] = serde_json::json!([]);
        }

        cfg["config"]["styles"]
            .as_array_mut()
            .ok_or_else(|| ErrorData::internal_error("styles is not an array", None))?
            .push(new_style);

        self.write_config(&cfg).await?;
        Ok(CallToolResult::success(vec![Content::text(
            format!("Style '{}' created", req.name),
        )]))
    }

    #[tool(description = "Delete a style by name. Cannot delete the 'default' style.")]
    async fn style_delete(
        &self,
        Parameters(req): Parameters<StyleDeleteRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        if req.name == "default" {
            return Ok(CallToolResult::success(vec![Content::text(
                "Cannot delete the 'default' style",
            )]));
        }

        let mut cfg = self.read_config().await?;
        let styles = cfg["config"]["styles"]
            .as_array_mut()
            .ok_or_else(|| ErrorData::internal_error("styles is not an array", None))?;

        let before = styles.len();
        styles.retain(|s| s["name"].as_str() != Some(&req.name));

        if styles.len() == before {
            return Ok(CallToolResult::success(vec![Content::text(
                format!("Style '{}' not found", req.name),
            )]));
        }

        self.write_config(&cfg).await?;
        Ok(CallToolResult::success(vec![Content::text(
            format!("Style '{}' deleted", req.name),
        )]))
    }

    #[tool(description = "Read a value from the Hyperia config (~/.hyperia/hyperia.json). \
        Pass a dot-separated path like 'config.fontSize' or 'config.defaultProfile' or \
        'config.ferricula.url'. Pass an empty string to dump the entire config. Returns the \
        JSON value as a string.")]
    async fn settings_get(
        &self,
        Parameters(req): Parameters<SettingsGetRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let cfg = self.read_config().await?;
        let value = walk_path(&cfg, &req.path);
        let body = serde_json::to_string_pretty(&value)
            .unwrap_or_else(|_| "null".into());
        Ok(CallToolResult::success(vec![Content::text(body)]))
    }

    #[tool(description = "Write a value to the Hyperia config (~/.hyperia/hyperia.json). \
        Pass a dot-separated path like 'config.fontSize' or 'config.defaultProfile' or \
        'config.ferricula.url', and the new value. Intermediate objects are created if needed. \
        Pass null as the value to remove the key. The change takes effect on next Hyperia \
        launch (or whenever the renderer re-reads config).")]
    async fn settings_set(
        &self,
        Parameters(req): Parameters<SettingsSetRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        if req.path.trim().is_empty() {
            return Ok(CallToolResult::success(vec![Content::text(
                "Error: path is required (e.g. 'config.fontSize').",
            )]));
        }
        let mut cfg = self.read_config().await?;
        let old = walk_path(&cfg, &req.path);
        match set_path(&mut cfg, &req.path, req.value.clone()) {
            Ok(()) => {
                self.write_config(&cfg).await?;
                let summary = serde_json::json!({
                    "ok": true,
                    "path": req.path,
                    "old_value": old,
                    "new_value": req.value,
                });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&summary).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                format!("Error setting '{}': {}", req.path, e),
            )])),
        }
    }

    #[tool(description = "Run a readiness probe across Hyperia's prerequisites and return a \
        structured JSON report. Checks: nuts.services token (configured + best-effort auth); \
        nemesis8 binary on disk; ferricula memory reachability + memory count; ollama running \
        + installed models; host platform + arch. Shivvr lives inside ferricula now, not as a \
        separate probe. Use this at session start to decide what to configure next.")]
    async fn doctor(&self) -> Result<CallToolResult, ErrorData> {
        let report = crate::ghost::registry::run_doctor().await;
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&report).unwrap_or_default(),
        )]))
    }

    #[tool(description = "List all terminal profiles defined in the Hyperia config. Returns \
        each profile's name and shell path so the agent can choose a sensible default or \
        propose changes.")]
    async fn settings_list_profiles(&self) -> Result<CallToolResult, ErrorData> {
        let cfg = self.read_config().await?;
        let profiles = cfg["config"]["profiles"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let summary: Vec<serde_json::Value> = profiles
            .iter()
            .map(|p| {
                serde_json::json!({
                    "name": p["name"].as_str().unwrap_or(""),
                    "shell": p["config"]["shell"].as_str().unwrap_or(""),
                    "shellArgs": p["config"]["shellArgs"].clone(),
                })
            })
            .collect();
        let default_profile = cfg["config"]["defaultProfile"].as_str().unwrap_or("");
        let body = serde_json::json!({
            "defaultProfile": default_profile,
            "profiles": summary,
        });
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&body).unwrap_or_default(),
        )]))
    }

    #[tool(description = "Add a custom terminal profile to the Hyperia configuration.")]
    async fn settings_add_profile(
        &self,
        Parameters(req): Parameters<SettingsAddProfileRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut cfg = self.read_config().await?;
        
        let config_obj = cfg["config"]
            .as_object_mut()
            .ok_or_else(|| ErrorData::internal_error("config key missing or not an object", None))?;
        
        if !config_obj.contains_key("profiles") {
            config_obj.insert("profiles".to_string(), serde_json::json!([]));
        }
        
        let profiles = config_obj["profiles"]
            .as_array_mut()
            .ok_or_else(|| ErrorData::internal_error("config.profiles is not an array", None))?;
        
        // Remove duplicate if it exists
        profiles.retain(|p| p["name"].as_str() != Some(&req.name));
        
        let new_profile = serde_json::json!({
            "name": req.name,
            "config": {
                "shell": req.shell,
                "shellArgs": req.shell_args.unwrap_or_default(),
                "env": req.env.unwrap_or_default(),
            }
        });
        profiles.push(new_profile);
        
        self.write_config(&cfg).await?;
        Ok(CallToolResult::success(vec![Content::text(
            format!("Profile '{}' added successfully.", req.name),
        )]))
    }

    #[tool(description = "Delete a terminal profile by name from the Hyperia configuration.")]
    async fn settings_delete_profile(
        &self,
        Parameters(req): Parameters<SettingsDeleteProfileRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut cfg = self.read_config().await?;
        
        let profiles = cfg["config"]["profiles"]
            .as_array_mut()
            .ok_or_else(|| ErrorData::internal_error("config.profiles not found or not an array", None))?;
        
        let original_len = profiles.len();
        profiles.retain(|p| p["name"].as_str() != Some(&req.name));
        
        if profiles.len() == original_len {
            return Ok(CallToolResult::success(vec![Content::text(
                format!("Profile '{}' not found.", req.name),
            )]));
        }
        
        self.write_config(&cfg).await?;
        Ok(CallToolResult::success(vec![Content::text(
            format!("Profile '{}' deleted successfully.", req.name),
        )]))
    }

    #[tool(description = "Toggle telemetry collection on or off.")]
    async fn telemetry_toggle(
        &self,
        Parameters(req): Parameters<TelemetryToggleRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"enabled": req.enabled});
        let resp = self.post_json("/api/telemetry/toggle", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Get a telemetry snapshot at window or pane level.")]
    async fn telemetry_snapshot(
        &self,
        Parameters(req): Parameters<TelemetrySnapshotRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let level = req.level.unwrap_or_else(|| "window".into());
        let mut url = format!("/api/telemetry/snapshot?level={}", level);
        if let Some(uid) = &req.pane_uid {
            url.push_str(&format!("&uid={}", uid));
        }
        let text = self.get(&url).await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    #[tool(description = "Record a telemetry event (file op, network, tokens) for a pane.")]
    async fn telemetry_record(
        &self,
        Parameters(req): Parameters<TelemetryEventRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut body = req.event.clone();
        if let Some(obj) = body.as_object_mut() {
            obj.insert("pane_uid".into(), serde_json::json!(req.pane_uid));
        }
        let resp = self.post_json("/api/telemetry/event", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Reset all telemetry counters.")]
    async fn telemetry_reset(&self) -> Result<CallToolResult, ErrorData> {
        let resp = self.post_json("/api/telemetry/reset", &serde_json::json!({})).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Set dashboard widget configuration on the fly.")]
    async fn dashboard_widgets(
        &self,
        Parameters(req): Parameters<DashboardWidgetsRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::Value::Array(req.widgets);
        let resp = self.post_json("/api/dashboard/widgets", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Read all pane screens across all windows and tabs. Returns labeled output grouped by window and tab. Great for getting a holistic view of everything. Pass focus= to extract only the relevant part — Maximus filters so you only see what you asked for. Pass raw=true to bypass Maximus.")]
    async fn tab_snapshot(
        &self,
        Parameters(req): Parameters<TabSnapshotRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let status_text = self.get("/api/status").await?;
        let status: serde_json::Value = serde_json::from_str(&status_text)
            .map_err(|e| ErrorData::internal_error(format!("Parse: {e}"), None))?;

        let mut output = String::new();
        if let Some(windows) = status["windows"].as_array() {
            for win in windows {
                let win_id = win["id"].as_u64().unwrap_or(0);
                output.push_str(&format!("=== Window {} ===\n", win_id));

                if let Some(tabs) = win["tabs"].as_array() {
                    for tab in tabs {
                        let tab_name = tab["name"].as_str().unwrap_or("shell");
                        if let Some(panes) = tab["panes"].as_array() {
                            for pane in panes {
                                let label = pane["label"].as_str().unwrap_or("");
                                let pane_id = pane["paneId"].as_str().unwrap_or("");
                                // Use paneId when label is empty so unlabeled panes are addressed individually
                                let pane_key = if label.is_empty() { pane_id } else { label };
                                let cols = pane["cols"].as_u64().unwrap_or(0);
                                let rows = pane["rows"].as_u64().unwrap_or(0);
                                let screen = self.get(&self.pane_path("/api/screen", Some(win_id as u32), Some(tab_name), Some(pane_key))).await
                                    .unwrap_or_else(|_| "(error reading screen)".into());

                                let header = if label.is_empty() {
                                    format!("--- {} | {}x{} ---", tab_name, cols, rows)
                                } else {
                                    format!("--- {} ({}) | {}x{} ---", tab_name, label, cols, rows)
                                };

                                output.push_str(&format!("{}\n{}\n\n", header, screen.trim()));
                            }
                        }
                    }
                }
            }
        }
        let out = self.maximus_filter(&output, req.focus.as_deref(), req.raw.unwrap_or(false)).await;
        Ok(CallToolResult::success(vec![Content::text(out)]))
    }

    #[tool(description = "Analyze all panes' screens and return their state: idle (at prompt), dialog (waiting for selection), running (command in progress), or empty.")]
    async fn shell_state(&self) -> Result<CallToolResult, ErrorData> {
        let status_text = self.get("/api/status").await?;
        let status: serde_json::Value = serde_json::from_str(&status_text)
            .map_err(|e| ErrorData::internal_error(format!("Parse: {e}"), None))?;

        let mut results = Vec::new();
        if let Some(windows) = status["windows"].as_array() {
            for win in windows {
                if let Some(tabs) = win["tabs"].as_array() {
                    for tab in tabs {
                        if let Some(panes) = tab["panes"].as_array() {
                            for pane in panes {
                                let label = pane["label"].as_str().unwrap_or("");
                                let pane_id = pane["paneId"].as_str().unwrap_or("");
                                let pane_key = if label.is_empty() { pane_id } else { label };
                                let tab_name = tab["name"].as_str().unwrap_or("shell");
                                let screen = self.get(&self.pane_path("/api/screen", Some(win["id"].as_u64().unwrap_or(0) as u32), Some(tab_name), Some(pane_key))).await
                                    .unwrap_or_default();

                                let shell = pane["shell"].as_str().unwrap_or("").to_string();
                                let process = pane["process"].as_str().unwrap_or("").to_string();
                                let state = detect_shell_state(&screen);
                                results.push(serde_json::json!({
                                    "window": win["id"],
                                    "tab": tab_name,
                                    "pane": if label.is_empty() { pane_id } else { label },
                                    "shell": shell,
                                    "process": process,
                                    "state": state.kind,
                                    "detail": state.detail,
                                    "actionable": state.actionable,
                                }));
                            }
                        }
                    }
                }
            }
        }
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&results).unwrap()
        )]))
    }

    #[tool(description = "Auto-handle common shell prompts (trust dialogs, update prompts, y/n confirmations). Target a specific pane with window/tab/pane, or omit all to scan every pane.")]
    async fn shell_confirm(
        &self,
        Parameters(req): Parameters<ShellConfirmRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        // If a specific pane is targeted, resolve and handle just that one
        if req.window.is_some() || req.tab.is_some() || req.pane.is_some() {
            let screen = self.get(&self.pane_path("/api/screen", req.window, req.tab.as_deref(), req.pane.as_deref())).await
                .unwrap_or_default();
            let state = detect_shell_state(&screen);

            if let Some(keys) = &state.actionable {
                self.post_text(&self.pane_path("/api/type", req.window, req.tab.as_deref(), req.pane.as_deref()), keys).await?;
                return Ok(CallToolResult::success(vec![Content::text(
                    format!("Sent '{}' ({})", keys.replace('\r', "\\r"), state.detail)
                )]));
            } else {
                return Ok(CallToolResult::success(vec![Content::text(
                    format!("No action needed ({})", state.kind)
                )]));
            }
        }

        // Otherwise scan all panes across all windows/tabs
        let status_text = self.get("/api/status").await?;
        let status: serde_json::Value = serde_json::from_str(&status_text)
            .map_err(|e| ErrorData::internal_error(format!("Parse: {e}"), None))?;

        let mut actions = Vec::new();
        if let Some(windows) = status["windows"].as_array() {
            for win in windows {
                if let Some(tabs) = win["tabs"].as_array() {
                    for tab in tabs {
                        let tab_name = tab["name"].as_str().unwrap_or("shell");
                        if let Some(panes) = tab["panes"].as_array() {
                            for pane in panes {
                                let label = pane["label"].as_str().unwrap_or("");
                                let pane_id = pane["paneId"].as_str().unwrap_or("");
                                let pane_key = if label.is_empty() { pane_id } else { label };
                                let win_id = win["id"].as_u64().unwrap_or(0) as u32;
                                let screen = self.get(&self.pane_path("/api/screen", Some(win_id), Some(tab_name), Some(pane_key))).await
                                    .unwrap_or_default();
                                let state = detect_shell_state(&screen);

                                let pane_desc = if label.is_empty() {
                                    format!("{} ({})", tab_name, &pane_key[..pane_key.len().min(8)])
                                } else {
                                    format!("{} ({})", tab_name, label)
                                };

                                if let Some(keys) = &state.actionable {
                                    self.post_text(&self.pane_path("/api/type", Some(win_id), Some(tab_name), Some(pane_key)), keys).await?;
                                    actions.push(format!("{}: sent '{}' ({})", pane_desc, keys.replace('\r', "\\r"), state.detail));
                                } else {
                                    actions.push(format!("{}: no action needed ({})", pane_desc, state.kind));
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(CallToolResult::success(vec![Content::text(actions.join("\n"))]))
    }

    #[tool(description = "BM25 full-text search across sticky notes. Ranks every note by relevance to your query (name + body). Returns JSON {hits:[{id, name, preview, score}]}. Use sticky_note_read with a returned id to get the full note. Faster + more precise than listing all notes and scanning.")]
    async fn sticky_note_search(
        &self,
        Parameters(req): Parameters<StickySearchRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut path = format!("/api/search/sticky?q={}", urlencoding::encode(&req.query));
        if let Some(l) = req.limit {
            path.push_str(&format!("&limit={}", l));
        }
        let resp = self.get(&path).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "BM25 full-text search across shell logs — the searchable history of everything that scrolled through your terminal panes (commands + output), kept per shell beyond the visible screen. Omit pane_id to search every shell; pass a paneId (from terminal_status) to search just one. Returns JSON {hits:[{session_uid, line_number, text, score, context_before:[], context_after:[]}]}. Use this to find 'where did I see that error', 'what was that command', etc. instead of scrolling.")]
    async fn shell_log_search(
        &self,
        Parameters(req): Parameters<ShellSearchRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut path = format!("/api/search/shell?q={}", urlencoding::encode(&req.query));
        if let Some(pid) = req.pane_id.as_deref() {
            path.push_str(&format!("&uid={}", urlencoding::encode(pid)));
        }
        if let Some(l) = req.limit {
            path.push_str(&format!("&limit={}", l));
        }
        if let Some(cl) = req.context_lines {
            path.push_str(&format!("&context_lines={}", cl));
        }
        let resp = self.get(&path).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Schedule a sticky note to run on a timer (Hyperia owns the timer + runners; the schedule survives restart). when='reminder' fires once after delay+unit (m/h/d); when='at' fires once at an ISO/datetime-local time; when='cron' fires on a 5-field cron expression. runner='notify' just shows a notification; 'shell' runs the note's text in a new Hyperia tab (in `dir` if given); 'n8shell' runs it in the nemesis8 container; 'n8agent' hands the note to the nemesis8 agent. Any runner other than notify LOCKS the note read-only (a 'hard' sticky) until unscheduled. Omit the schedule fields / pass unschedule=true to clear.")]
    async fn sticky_note_schedule(
        &self,
        Parameters(req): Parameters<StickyScheduleRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = if req.unschedule.unwrap_or(false) {
            serde_json::json!({"schedule": serde_json::Value::Null})
        } else {
            serde_json::json!({
                "when": req.when.unwrap_or_else(|| "reminder".into()),
                "runner": req.runner.unwrap_or_else(|| "notify".into()),
                "delay": req.delay,
                "unit": req.unit,
                "at": req.at,
                "cron": req.cron,
                "dir": req.dir,
            })
        };
        let resp = self.post_json(&format!("/api/notes/{}/schedule", req.id), &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Grapheme-safe, transactional file editor (Aegis-Edit / LOPT+BFTP). Apply one or more DISJOINT edits to a UTF-8 text file by (line, column) where columns are extended grapheme clusters — so it can NEVER split a multibyte codepoint or emoji the way a byte-offset edit can. Coordinates are 0-based; for a pure insert set end==start; empty `text` is a pure delete. Multiple edits are validated up front (overlaps rejected → file untouched) and applied back-to-front so earlier offsets don't shift. Pass preview=true to get the resulting content WITHOUT writing. Returns JSON {ok, path, lines, bytes, applied, preview}. Prefer this over file_write for in-place edits to existing files.")]
    async fn apply_text_edits(
        &self,
        Parameters(req): Parameters<ApplyEditsRequest>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({
            "path": req.path,
            "edits": req.edits.iter().map(|e| serde_json::json!({
                "start_line": e.start_line,
                "start_col": e.start_col,
                "end_line": e.end_line,
                "end_col": e.end_col,
                "text": e.text,
            })).collect::<Vec<_>>(),
            "preview": req.preview.unwrap_or(false),
        });
        let resp = self.post_json_as("/api/edit/apply", &body, forwarded_auth(&ctx).as_deref()).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "List all sticky notes. Returns id, name, text preview, color, and position for each note.")]
    async fn sticky_note_list(&self) -> Result<CallToolResult, ErrorData> {
        let resp = self.get("/api/notes").await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Create a new sticky note floating window. Optionally provide initial text and a background color hex. Returns {ok, id, name} — use the returned id/name directly; no need to call sticky_note_list afterward.")]
    async fn sticky_note_create(
        &self,
        Parameters(req): Parameters<NoteCreateRequest>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"text": req.text, "color": req.color});
        let resp = self.post_json_as("/api/notes", &body, forwarded_auth(&ctx).as_deref()).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Close an open sticky note window by its ID. Use sticky_note_list to get IDs. The note's content is preserved on disk.")]
    async fn sticky_note_close(
        &self,
        Parameters(req): Parameters<NoteCloseRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"id": req.id});
        let resp = self.post_json("/api/notes/close", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Open (show) a sticky note window by its ID — brings an existing or closed note onto the screen and raises it. Use sticky_note_list to get IDs.")]
    async fn sticky_note_open(
        &self,
        Parameters(req): Parameters<NoteOpenRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"id": req.id});
        let resp = self.post_json("/api/notes/open", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Open a source file as a code-highlighted sticky note. The note reads the file directly from the Hyperia host's disk. Provide an absolute path reachable from that host — if the file can't be read (e.g. a container/remote /workspace path that doesn't exist on this OS), the call returns {ok:false, error:...} and creates nothing instead of silently succeeding. On success returns {ok, id, name}.")]
    async fn sticky_note_create_code(
        &self,
        Parameters(req): Parameters<StickyNoteCreateCodeRequest>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let color = match req.theme.as_deref().unwrap_or("dark") {
            "light" => "code:light",
            _ => "code:dark",
        };
        let body = serde_json::json!({
            "file_path": req.file_path,
            "color": color,
            "x": req.x,
            "y": req.y,
            "width": req.width.unwrap_or(800),
            "height": req.height.unwrap_or(600),
        });
        let resp = self.post_json_as("/api/notes", &body, forwarded_auth(&ctx).as_deref()).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Update the text content of an existing sticky note. Use sticky_note_list to get IDs.")]
    async fn sticky_note_update(
        &self,
        Parameters(req): Parameters<StickyNoteUpdateRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"text": req.text});
        let resp = self.patch_json(&format!("/api/notes/{}", req.id), &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Permanently delete a sticky note by its ID. Use sticky_note_list to get IDs. This cannot be undone.")]
    async fn sticky_note_delete(
        &self,
        Parameters(req): Parameters<StickyNoteDeleteRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let resp = self.delete(&format!("/api/notes/{}", req.id)).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Read the full text content of a sticky note by its ID. Use sticky_note_list to get IDs.")]
    async fn sticky_note_read(
        &self,
        Parameters(req): Parameters<StickyNoteReadRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let resp = self.get(&format!("/api/notes/{}", req.id)).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Auto-describe a pane using local ollama. Reads screen content, generates a short description, and stores it on the tab.")]
    async fn auto_describe(
        &self,
        Parameters(req): Parameters<AutoDescribeRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let resp = self.post_text(&self.pane_path("/api/pane/describe", req.window, req.tab.as_deref(), req.pane.as_deref()), "").await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

}

// -- Output cleaning --

/// Strip ANSI/VT escape sequences from raw PTY output and truncate at `max_chars`.
/// Appends a truncation notice with the override hint when content is cut.
fn clean_terminal_output(raw: &str, max_chars: usize) -> String {
    // Strip escape sequences: ESC [ ... final-byte  and  ESC single-char
    let mut out = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            i += 1;
            if i < bytes.len() {
                match bytes[i] {
                    b'[' => {
                        // CSI sequence: skip until a byte in 0x40..=0x7e
                        i += 1;
                        while i < bytes.len() && !(0x40..=0x7eu8).contains(&bytes[i]) {
                            i += 1;
                        }
                        i += 1; // skip the final byte
                    }
                    b']' => {
                        // OSC sequence: skip until ST (ESC \) or BEL
                        i += 1;
                        while i < bytes.len() {
                            if bytes[i] == 0x07 { i += 1; break; }
                            if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                                i += 2; break;
                            }
                            i += 1;
                        }
                    }
                    _ => { i += 1; } // skip single-char escape
                }
            }
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    // Normalise \r\n → \n
    let out = out.replace("\r\n", "\n").replace('\r', "\n");
    let total = out.chars().count();
    if total <= max_chars {
        out
    } else {
        let truncated_at = out.char_indices().nth(max_chars).map(|(i, _)| i).unwrap_or(out.len());
        let remaining = total - max_chars;
        format!(
            "{}\n[Output truncated: {} chars not shown (total {}). Re-run with max_output_chars={} to see more.]",
            &out[..truncated_at],
            remaining,
            total,
            total + 1000, // suggest a value that would fit everything
        )
    }
}

// -- Key unescaping --

/// Convert literal escape sequences (\n, \r, \t) to actual control characters.
/// Strip trailing newline / carriage-return sequences that agents append.
/// Handles real chars (\r, \n) and escape literals (\\n, \\r, /n, /r).
/// Detect shell-level backgrounding hacks (Start-Process, nohup, & at end,
/// tmux). Returns the matched pattern name for the agent-facing message.
/// Conservative on purpose: we only flag the small set of patterns we
/// actually want to redirect into terminal_split / terminal_new_tab.
fn looks_like_background_hack(cmd: &str) -> Option<&'static str> {
    let trimmed = cmd.trim();
    let lower = trimmed.to_lowercase();
    // PowerShell: Start-Process (case-insensitive; sometimes with backtick-newline)
    if lower.contains("start-process") {
        return Some("Start-Process");
    }
    // Posix shell: leading `nohup `
    if lower.starts_with("nohup ") || lower.contains(" nohup ") {
        return Some("nohup");
    }
    // tmux session start (`tmux new`, `tmux new-session`, `tmux attach` in scripts)
    if lower.starts_with("tmux ") || lower.contains(" tmux ") {
        return Some("tmux");
    }
    // GNU screen
    if lower.starts_with("screen -") || lower.contains(" screen -") {
        return Some("screen");
    }
    // Trailing ` &` — but NOT `&&` (logical-and) and NOT `&>` (stderr redirect).
    // Look at the *last* non-whitespace char and what precedes it.
    let bytes = trimmed.as_bytes();
    if let Some(&last) = bytes.last() {
        if last == b'&' {
            // Exclude `&&` (which has a second & one step back).
            let second_to_last = bytes.get(bytes.len().saturating_sub(2)).copied();
            if second_to_last != Some(b'&') {
                return Some("trailing &");
            }
        }
    }
    None
}

fn strip_trailing_returns(s: &str) -> &str {
    let mut s = s.trim_end();
    loop {
        // Real CR/LF
        if let Some(stripped) = s.strip_suffix('\n') { s = stripped.trim_end_matches('\r'); continue; }
        if let Some(stripped) = s.strip_suffix('\r') { s = stripped; continue; }
        // Escaped: \n \r \\n \\r
        if let Some(stripped) = s.strip_suffix("\\n") { s = stripped; continue; }
        if let Some(stripped) = s.strip_suffix("\\r") { s = stripped; continue; }
        // Forward-slash typo: /n /r
        if let Some(stripped) = s.strip_suffix("/n") { s = stripped; continue; }
        if let Some(stripped) = s.strip_suffix("/r") { s = stripped; continue; }
        break;
    }
    s
}

fn unescape_keys(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' {
            out.push('\r');
        } else if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\r'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('e') => out.push('\x1b'),
                Some('\\') => out.push('\\'),
                Some('x') => {
                    let mut hex = String::new();
                    if let Some(&h1) = chars.peek() {
                        if h1.is_ascii_hexdigit() {
                            chars.next();
                            hex.push(h1);
                            if let Some(&h2) = chars.peek() {
                                if h2.is_ascii_hexdigit() {
                                    chars.next();
                                    hex.push(h2);
                                }
                            }
                        }
                    }
                    if !hex.is_empty() {
                        if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                            out.push(byte as char);
                        } else {
                            out.push('\\');
                            out.push('x');
                            out.push_str(&hex);
                        }
                    } else {
                        out.push('\\');
                        out.push('x');
                    }
                }
                Some('u') => {
                    let mut hex = String::new();
                    for _ in 0..4 {
                        if let Some(&h) = chars.peek() {
                            if h.is_ascii_hexdigit() {
                                chars.next();
                                hex.push(h);
                            } else {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    if hex.len() == 4 {
                        if let Ok(val) = u32::from_str_radix(&hex, 16) {
                            if let Some(ch) = std::char::from_u32(val) {
                                out.push(ch);
                            } else {
                                out.push('\\');
                                out.push('u');
                                out.push_str(&hex);
                            }
                        } else {
                            out.push('\\');
                            out.push('u');
                            out.push_str(&hex);
                        }
                    } else {
                        out.push('\\');
                        out.push('u');
                        out.push_str(&hex);
                    }
                }
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    
    // Process control character combinations like ctrl+X, Ctrl+X, C-x, c-X, CTRL+X
    let mut result = out;
    let prefixes = ["ctrl+", "Ctrl+", "CTRL+", "c-", "C-"];
    for prefix in prefixes {
        while let Some(pos) = result.to_lowercase().find(&prefix.to_lowercase()) {
            if pos + prefix.len() < result.len() {
                let ch = result.as_bytes()[pos + prefix.len()];
                let ch_upper = (ch as char).to_ascii_uppercase();
                if ch_upper >= 'A' && ch_upper <= 'Z' {
                    let ctrl_char = ((ch_upper as u8) - b'A' + 1) as char;
                    result = format!(
                        "{}{}{}",
                        &result[..pos],
                        ctrl_char,
                        &result[pos + prefix.len() + 1..]
                    );
                } else if ch as char == '[' {
                    result = format!(
                        "{}{}{}",
                        &result[..pos],
                        '\x1b',
                        &result[pos + prefix.len() + 1..]
                    );
                } else {
                    result = format!(
                        "{}{}",
                        &result[..pos],
                        &result[pos + prefix.len()..]
                    );
                }
            } else {
                break;
            }
        }
    }
    result
}

// -- Settings path helpers --

/// Walk a dot-separated path into a JSON value, returning a clone of the
/// matching subtree (or Null if the path doesn't exist). Empty path = the
/// whole document.
fn walk_path(value: &serde_json::Value, path: &str) -> serde_json::Value {
    if path.trim().is_empty() {
        return value.clone();
    }
    let mut cur = value;
    for key in path.split('.') {
        match cur {
            serde_json::Value::Object(map) => match map.get(key) {
                Some(v) => cur = v,
                None => return serde_json::Value::Null,
            },
            _ => return serde_json::Value::Null,
        }
    }
    cur.clone()
}

/// Set a value at a dot-separated path, creating intermediate objects as
/// needed. Passing Null as the new value removes the leaf key.
fn set_path(
    value: &mut serde_json::Value,
    path: &str,
    new_value: serde_json::Value,
) -> Result<(), String> {
    let keys: Vec<&str> = path.split('.').collect();
    if keys.is_empty() {
        return Err("empty path".into());
    }
    let (last, parents) = keys.split_last().unwrap();
    let mut cur = value;
    for key in parents {
        // Promote non-object intermediates to objects (overwrites primitives).
        if !cur.is_object() {
            *cur = serde_json::Value::Object(serde_json::Map::new());
        }
        let map = cur.as_object_mut().unwrap();
        if !map.contains_key(*key) {
            map.insert((*key).to_string(), serde_json::Value::Object(serde_json::Map::new()));
        }
        cur = map.get_mut(*key).unwrap();
    }
    if !cur.is_object() {
        *cur = serde_json::Value::Object(serde_json::Map::new());
    }
    let map = cur.as_object_mut().unwrap();
    if new_value.is_null() {
        map.remove(*last);
    } else {
        map.insert((*last).to_string(), new_value);
    }
    Ok(())
}

// -- Shell state detection --

struct ShellStateInfo {
    kind: String,
    detail: String,
    /// If set, the keys to send to resolve the prompt
    actionable: Option<String>,
}

fn detect_shell_state(screen: &str) -> ShellStateInfo {
    let lower = screen.to_lowercase();

    // Claude Code trust dialog
    if lower.contains("yes, i trust this folder") && lower.contains("enter to confirm") {
        return ShellStateInfo {
            kind: "dialog".into(),
            detail: "Claude Code trust folder prompt".into(),
            actionable: Some("\r".into()),
        };
    }

    // Update available prompt (codex/nemesis8)
    if lower.contains("update available") && lower.contains("skip") {
        return ShellStateInfo {
            kind: "dialog".into(),
            detail: "Update available prompt".into(),
            actionable: Some("2\r".into()),
        };
    }

    // Generic y/n prompt
    if lower.contains("[y/n]") || lower.contains("(y/n)") {
        return ShellStateInfo {
            kind: "dialog".into(),
            detail: "y/n confirmation".into(),
            actionable: Some("y\r".into()),
        };
    }

    // Press enter to continue
    if lower.contains("press enter to continue") || lower.contains("press any key") {
        return ShellStateInfo {
            kind: "dialog".into(),
            detail: "Press enter prompt".into(),
            actionable: Some("\r".into()),
        };
    }

    // Claude Code ready (has prompt marker)
    if screen.contains("\u{276f}") || screen.contains("❯") {
        // Check if it's a blank prompt (idle)
        let lines: Vec<&str> = screen.lines().filter(|l| !l.trim().is_empty()).collect();
        if let Some(last) = lines.last() {
            if last.trim() == "\u{276f}" || last.trim() == "❯" || last.trim().ends_with("❯") {
                return ShellStateInfo {
                    kind: "idle".into(),
                    detail: "At prompt, ready for input".into(),
                    actionable: None,
                };
            }
        }
    }

    // Windows cmd prompt
    if screen.contains(":\\") && screen.contains(">") {
        let lines: Vec<&str> = screen.lines().filter(|l| !l.trim().is_empty()).collect();
        if let Some(last) = lines.last() {
            if last.contains(">") && !last.contains("error") {
                return ShellStateInfo {
                    kind: "idle".into(),
                    detail: "At cmd prompt".into(),
                    actionable: None,
                };
            }
        }
    }

    // Working/running indicator
    if lower.contains("working") || lower.contains("compiling") || lower.contains("building")
        || lower.contains("installing") || lower.contains("downloading") {
        return ShellStateInfo {
            kind: "running".into(),
            detail: "Command in progress".into(),
            actionable: None,
        };
    }

    // Empty/blank screen
    let non_empty: Vec<&str> = screen.lines().filter(|l| !l.trim().is_empty()).collect();
    if non_empty.is_empty() {
        return ShellStateInfo {
            kind: "empty".into(),
            detail: "Blank screen".into(),
            actionable: None,
        };
    }

    ShellStateInfo {
        kind: "unknown".into(),
        detail: "Unrecognized state".into(),
        actionable: None,
    }
}

// -- Helper methods --

impl HyperiaMcp {
    /// Focus a pane by window/tab/pane address (fire-and-forget, best-effort).
    async fn focus_pane(&self, window: Option<u32>, tab: Option<&str>, pane: Option<&str>) {
        let body = serde_json::json!({"window": window, "tab": tab, "pane": pane});
        let _ = self.post_json("/api/pane/focus", &body).await;
    }

    fn pane_path(&self, base: &str, window: Option<u32>, tab: Option<&str>, pane: Option<&str>) -> String {
        let mut params = Vec::new();
        if let Some(window) = window {
            params.push(format!("window={}", window));
        }
        if let Some(tab) = tab {
            params.push(format!("tab={}", urlencoding::encode(tab)));
        }
        if let Some(pane) = pane {
            params.push(format!("pane={}", urlencoding::encode(pane)));
        }
        if params.is_empty() {
            base.to_string()
        } else {
            format!("{}?{}", base, params.join("&"))
        }
    }

    async fn get(&self, path: &str) -> Result<String, ErrorData> {
        let resp = self.client
            .get(format!("{}{}", self.base_url, path))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;
        resp.text().await
            .map_err(|e| ErrorData::internal_error(format!("Read error: {e}"), None))
    }

    async fn post_text(&self, path: &str, body: &str) -> Result<String, ErrorData> {
        self.post_text_with_timeout(path, body, None).await
    }

    /// POST with an optional per-request timeout that overrides the client default.
    /// Use this for endpoints that can legitimately take longer than 10s (e.g. type-and-collect
    /// with a long quiet_ms). Pass None to use the client's default 10s timeout.
    async fn post_text_with_timeout(
        &self,
        path: &str,
        body: &str,
        timeout: Option<std::time::Duration>,
    ) -> Result<String, ErrorData> {
        let mut req = self.client
            .post(format!("{}{}", self.base_url, path))
            .body(body.to_string());
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        let resp = req.send().await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;
        resp.text().await
            .map_err(|e| ErrorData::internal_error(format!("Read error: {e}"), None))
    }

    fn config_path(&self) -> std::path::PathBuf {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".into());
        std::path::PathBuf::from(home).join(".hyperia").join("hyperia.json")
    }

    async fn read_config(&self) -> Result<serde_json::Value, ErrorData> {
        let path = self.config_path();
        let data = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| ErrorData::internal_error(format!("Read config: {e}"), None))?;
        serde_json::from_str(&data)
            .map_err(|e| ErrorData::internal_error(format!("Parse config: {e}"), None))
    }

    async fn write_config(&self, cfg: &serde_json::Value) -> Result<(), ErrorData> {
        let path = self.config_path();
        let data = serde_json::to_string_pretty(cfg)
            .map_err(|e| ErrorData::internal_error(format!("Serialize config: {e}"), None))?;
        tokio::fs::write(&path, data.as_bytes())
            .await
            .map_err(|e| ErrorData::internal_error(format!("Write config: {e}"), None))
    }

    /// post_json that forwards a caller Authorization header on the internal
    /// hop, so gated endpoints (enforce_drive/enforce_create) see the real
    /// identity instead of anonymous.
    async fn post_json_as(
        &self,
        path: &str,
        body: &serde_json::Value,
        auth: Option<&str>,
    ) -> Result<String, ErrorData> {
        let mut rb = self.client.post(format!("{}{}", self.base_url, path)).json(body);
        if let Some(a) = auth {
            rb = rb.header(reqwest::header::AUTHORIZATION, a);
        }
        let resp = rb
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;
        resp.text()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Read error: {e}"), None))
    }

    /// post_text variant that forwards a caller Authorization header (+ optional
    /// timeout) for the gated drive endpoints.
    async fn post_text_as(
        &self,
        path: &str,
        body: &str,
        timeout: Option<std::time::Duration>,
        auth: Option<&str>,
    ) -> Result<String, ErrorData> {
        let mut rb = self.client.post(format!("{}{}", self.base_url, path)).body(body.to_string());
        if let Some(t) = timeout {
            rb = rb.timeout(t);
        }
        if let Some(a) = auth {
            rb = rb.header(reqwest::header::AUTHORIZATION, a);
        }
        let resp = rb
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;
        resp.text()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Read error: {e}"), None))
    }

    async fn post_json(&self, path: &str, body: &serde_json::Value) -> Result<String, ErrorData> {
        let resp = self.client
            .post(format!("{}{}", self.base_url, path))
            .json(body)
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;
        resp.text().await
            .map_err(|e| ErrorData::internal_error(format!("Read error: {e}"), None))
    }

    async fn patch_json(&self, path: &str, body: &serde_json::Value) -> Result<String, ErrorData> {
        let resp = self.client
            .patch(format!("{}{}", self.base_url, path))
            .json(body)
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;
        resp.text().await
            .map_err(|e| ErrorData::internal_error(format!("Read error: {e}"), None))
    }

    async fn delete(&self, path: &str) -> Result<String, ErrorData> {
        let resp = self.client
            .delete(format!("{}{}", self.base_url, path))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;
        resp.text().await
            .map_err(|e| ErrorData::internal_error(format!("Read error: {e}"), None))
    }

}

// -- ServerHandler impl --

#[tool_handler]
impl ServerHandler for HyperiaMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            instructions: Some(
                "Hyperia MCP server — controls a running Hyperia terminal emulator. \
                 \n\nCRITICAL — UI-FIRST PRINCIPLE: Hyperia gives you unlimited terminal panes and \
                 tabs. NEVER use shell-level backgrounding to run servers, watchers, REPLs, or any \
                 long-running task. That includes: PowerShell `Start-Process`, `nohup`, `tmux`, \
                 `screen`, and a trailing ` &` in bash. Instead: call `terminal_split` (or \
                 `terminal_new_tab`) to create a dedicated visible pane, then `terminal_run` the \
                 process in the foreground inside it. The human can see it, you can read its output \
                 any time via `terminal_screen`, and closing the pane closes the process. The \
                 `terminal_run` tool refuses these patterns by default — set `force=true` only if \
                 you genuinely need OS-level backgrounding and not a Hyperia pane. \
                 \n\nIDENTITY & PERMISSIONS: If you're running inside a Hyperia pane, your identity is \
                 in the HYPERIA_AGENT_TOKEN env var. Present it as your MCP Authorization header \
                 (Bearer ${HYPERIA_AGENT_TOKEN}) so Hyperia knows which pane you are. This is your \
                 NAME BADGE, not a secret to protect: it's a low-privilege identity that only names \
                 you and grants nothing on its own — finding it in your env is expected, not a leak. \
                 Every state-changing action (opening tabs/panes/windows, driving another pane) \
                 requires the human's consent, which they approve in the Hyperia UI; a denied or \
                 ungranted action returns 202 (awaiting approval) or 403 (denied), not a silent pass. \
                 You CANNOT drive the pane you're running in — you're already there; split or open a \
                 new pane for a worker shell. If a call returns a 'No identity' message, wire the \
                 Authorization header as above and retry. \
                 \n\nAddressing: Hyperia organizes sessions as windows > tabs > panes. \
                 Call terminal_status to see the full hierarchy. Most tools accept optional \
                 window (id), tab (name), and pane (label) parameters: \
                 - Omit all three to target the focused window's active tab's first pane. \
                 - Specify window using the `id` field from terminal_status (NOT 0-based; first window is typically id=1). \
                 - Specify tab to pick a tab by name (e.g. \"Capybara\"). \
                 - Specify pane to pick a split pane by label (\"a\", \"b\", \"c\"). \
                 For a full view of all pane contents, use tab_snapshot. \
                 \n\nDiscovery: call skills to list Hyperia's capability areas and the tools that perform each. \
                 \n\nTerminal: terminal_keys, terminal_run, terminal_screen, terminal_status, \
                 terminal_split, terminal_focus, terminal_close, terminal_new_tab, terminal_new_window, \
                 terminal_where_pane, tab_snapshot, shell_state, shell_confirm, open_web_pane. \
                 \n\nSticky notes: sticky_note_list, sticky_note_create, sticky_note_create_code, \
                 sticky_note_update, sticky_note_close, sticky_note_delete. \
                 \n\nAgent: agent_status, auto_describe. \
                 \n\nStyles: style_list, style_create, style_delete. \
                 \n\nTelemetry: telemetry_toggle, telemetry_snapshot, telemetry_record, telemetry_reset. \
                 \n\nLogs: sidecar_logs."
                    .into(),
            ),
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .build(),
            ..Default::default()
        }
    }
}

/// Run the MCP server over stdio. Connects to sidecar HTTP API at the given port.
pub async fn run_mcp_stdio(http_port: u16) -> anyhow::Result<()> {
    let server = HyperiaMcp::new(http_port);
    let service = server.serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    Ok(())
}

/// Return a Tower service that serves MCP over the Streamable HTTP transport.
/// Mount with `.nest_service("/mcp", mcp::streamable_http_service(port))`.
/// Claude Code connects via: claude mcp add hyperia --sse http://localhost:9800/mcp
///
/// Stateful_mode is forced to false. The default is true, which makes the
/// server keep a per-client session id table and reject requests whose id
/// it doesn't recognize. Every time the sidecar restarted (every hot-swap,
/// every `yarn dist`, every crash + Hyperia respawn), Claude Code's MCP
/// client would suddenly get HTTP 404 on every call because the new
/// sidecar process had a fresh, empty session table. Reconnecting via
/// `/mcp` worked but interrupted every iteration. None of our tools rely
/// on session continuity (each is a one-shot JSON-RPC call), so
/// stateless is correct: each request is processed independently, no
/// session lookup, sidecar restarts are invisible to the client.
pub fn streamable_http_service(
    http_port: u16,
) -> rmcp::transport::streamable_http_server::StreamableHttpService<HyperiaMcp> {
    use rmcp::transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService,
    };
    StreamableHttpService::new(
        move || Ok(HyperiaMcp::new(http_port)),
        Default::default(),
        StreamableHttpServerConfig {
            stateful_mode: false,
            ..Default::default()
        },
    )
}
