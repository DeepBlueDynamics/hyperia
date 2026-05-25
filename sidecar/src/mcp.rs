use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router,
};

use crate::ghost::compressor::{ContextCompressor, FOCUS_MIN_CHARS};

// -- Tool request schemas --

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct KeysRequest {
    /// Keystrokes to type into the terminal. Use \n for Enter, \t for Tab.
    pub keys: String,
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct RunRequest {
    /// Shell command or text to type
    pub command: String,
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
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
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ScreenRequest {
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
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
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct FocusRequest {
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct NewTabRequest {
    /// Shell command to run after the tab opens (e.g. "cd /my/project && claude")
    pub command: Option<String>,
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
pub struct OpenWebPaneRequest {
    /// Full URL to open (e.g. "https://localhost:3000" or "https://example.com")
    pub url: String,
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
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
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
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct AutoDescribeRequest {
    /// Window ID — the `id` field from terminal_status (not 0-based; first window is usually 1). Omit to use the focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
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

    #[tool(description = "Type keystrokes into a terminal pane. Use \\n for Enter, \\r for Return, \\t for Tab. These are unescaped automatically. Address panes with window/tab/pane. The pane field accepts either a pane label or the paneId from terminal_status; if the label is empty, use paneId.")]
    async fn terminal_keys(
        &self,
        Parameters(req): Parameters<KeysRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        self.focus_pane(req.window, req.tab.as_deref(), req.pane.as_deref()).await;
        let keys = unescape_keys(&req.keys);
        let resp = self
            .post_text(&self.pane_path("/api/type", req.window, req.tab.as_deref(), req.pane.as_deref()), &keys)
            .await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Type text into a terminal pane and press Enter. Works for shell commands and interactive programs (Codex, Python REPL, vim, etc.). Set submit=false to type without pressing Enter — useful to let the human review before submitting. Pass focus= to receive only the relevant part of the output — Maximus filters the result so you only see what you asked for. Pass raw=true to bypass Maximus and see the full output.")]
    async fn terminal_run(
        &self,
        Parameters(req): Parameters<RunRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        self.focus_pane(req.window, req.tab.as_deref(), req.pane.as_deref()).await;
        let submit = req.submit.unwrap_or(true);
        let wait = req.wait_ms.unwrap_or(if submit { 2000 } else { 200 });
        let cmd = strip_trailing_returns(&req.command);

        if submit {
            // Use type-and-collect: sends the command, streams all PTY output until
            // wait_ms of silence (up to 8s hard cap). Returns full output, not just
            // the visible screen — avoids silent truncation of long command output.
            let base = self.pane_path("/api/type-and-collect", req.window, req.tab.as_deref(), req.pane.as_deref());
            let sep = if base.contains('?') { '&' } else { '?' };
            let collect_path = format!("{}{sep}quiet_ms={}", base, wait);
            // Give the HTTP client headroom over the server's quiet window so it doesn't
            // time out before /api/type-and-collect finishes draining PTY output.
            let req_timeout = std::time::Duration::from_millis(wait + 15_000);
            let raw_output = self
                .post_text_with_timeout(&collect_path, &format!("{}\r", cmd), Some(req_timeout))
                .await?;
            let max_chars = req.max_output_chars.unwrap_or(12_000);
            let text = clean_terminal_output(&raw_output, max_chars);
            let out = self.maximus_filter(&text, req.focus.as_deref(), req.raw.unwrap_or(false)).await;
            Ok(CallToolResult::success(vec![Content::text(out)]))
        } else {
            // submit=false: just type the text without waiting for output
            let pane_path = self.pane_path("/api/type", req.window, req.tab.as_deref(), req.pane.as_deref());
            self.post_text(&pane_path, cmd).await?;
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

    #[tool(description = "List all open windows, tabs, and panes in a nested hierarchy. Each window has an `id` field — pass that exact value as the `window` parameter in other tools (it is NOT 0-based; the first window is typically id=1). Each pane includes both a label and a paneId. Use the pane label when present; if the label is empty, use paneId when addressing that pane in other tools.")]
    async fn terminal_status(&self) -> Result<CallToolResult, ErrorData> {
        let text = self.get("/api/status").await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    #[tool(description = "Split the currently focused pane into two. Direction: 'horizontal' (top/bottom) or 'vertical' (left/right, default). The new panes will be labeled with the next available letters. Use terminal_status after splitting to see the updated labels.")]
    async fn terminal_split(
        &self,
        Parameters(req): Parameters<SplitRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({
            "direction": req.direction.unwrap_or_else(|| "vertical".into()),
        });
        let resp = self.post_json("/api/pane/split", &body).await?;
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
    async fn terminal_close(&self) -> Result<CallToolResult, ErrorData> {
        let resp = self.post_json("/api/pane/close", &serde_json::json!({})).await?;
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

    #[tool(description = "Open a new tab. Optionally run a startup command in it.")]
    async fn terminal_new_tab(
        &self,
        Parameters(req): Parameters<NewTabRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut body = serde_json::json!({});
        if let Some(cmd) = &req.command {
            body["command"] = serde_json::json!(cmd);
        }
        let resp = self.post_json("/api/pane/new", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Open a new Hyperia OS window (separate from the current window). Use terminal_status after to get its window `id` for targeting other tools. Use when the user wants a separate window, not just a new tab.")]
    async fn terminal_new_window(&self) -> Result<CallToolResult, ErrorData> {
        let resp = self.post_json("/api/window/new", &serde_json::json!({})).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Open a URL in a new dedicated web pane tab inside Hyperia. Opens an embedded browser tab alongside your terminal tabs — does NOT replace or overlay any existing terminal. Pass a full URL (https://...). Use this to show docs, dashboards, localhost servers, or any web content.")]
    async fn open_web_pane(
        &self,
        Parameters(req): Parameters<OpenWebPaneRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let resp = self.post_json("/api/web-pane", &serde_json::json!({"url": req.url})).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Read sidecar logs.")]
    async fn sidecar_logs(&self) -> Result<CallToolResult, ErrorData> {
        let text = self.get("/api/logs").await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
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

    #[tool(description = "List all sticky notes. Returns id, name, text preview, color, and position for each note.")]
    async fn sticky_note_list(&self) -> Result<CallToolResult, ErrorData> {
        let resp = self.get("/api/notes").await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Create a new sticky note floating window. Optionally provide initial text and a background color hex.")]
    async fn sticky_note_create(
        &self,
        Parameters(req): Parameters<NoteCreateRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"text": req.text, "color": req.color});
        let resp = self.post_json("/api/notes", &body).await?;
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

    #[tool(description = "Open a source file as a code-highlighted sticky note. The note reads directly from disk. Provide a verified absolute path — the sidecar will reject the call if the file does not exist.")]
    async fn sticky_note_create_code(
        &self,
        Parameters(req): Parameters<StickyNoteCreateCodeRequest>,
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
        let resp = self.post_json("/api/notes", &body).await?;
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
        if c == '\\' {
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
                 \n\nAddressing: Hyperia organizes sessions as windows > tabs > panes. \
                 Call terminal_status to see the full hierarchy. Most tools accept optional \
                 window (id), tab (name), and pane (label) parameters: \
                 - Omit all three to target the focused window's active tab's first pane. \
                 - Specify window using the `id` field from terminal_status (NOT 0-based; first window is typically id=1). \
                 - Specify tab to pick a tab by name (e.g. \"Capybara\"). \
                 - Specify pane to pick a split pane by label (\"a\", \"b\", \"c\"). \
                 For a full view of all pane contents, use tab_snapshot. \
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
