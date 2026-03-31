use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router,
};

// -- Tool request schemas --

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct KeysRequest {
    /// Keystrokes to type into the terminal. Use \n for Enter, \t for Tab.
    pub keys: String,
    /// Window index (0, 1, 2...). Omit for focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct RunRequest {
    /// Shell command to execute (Enter is appended automatically)
    pub command: String,
    /// Window index (0, 1, 2...). Omit for focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
    pub pane: Option<String>,
    /// Milliseconds to wait for output before reading screen (default: 2000)
    pub wait_ms: Option<u64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ScreenRequest {
    /// Window index (0, 1, 2...). Omit for focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SplitRequest {
    /// Split direction: "horizontal" or "vertical" (default: vertical)
    pub direction: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct FocusRequest {
    /// Window index (0, 1, 2...). Omit for focused window.
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
    /// Window index (0, 1, 2...). Omit for focused window.
    pub window: Option<u32>,
    /// Current tab name to rename. Omit for active tab.
    pub tab: Option<String>,
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
    /// Window index (0, 1, 2...). Omit for focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
    pub pane: Option<String>,
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
    /// Window index (0, 1, 2...). Omit for focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
    pub pane: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct AutoDescribeRequest {
    /// Window index (0, 1, 2...). Omit for focused window.
    pub window: Option<u32>,
    /// Tab name (e.g. "Capybara"). Omit for active tab in the window.
    pub tab: Option<String>,
    /// Pane label within the tab (e.g. "a", "b"). Omit for first pane.
    pub pane: Option<String>,
}

// -- MCP Server --

#[derive(Clone)]
pub struct HyperiaMcp {
    tool_router: ToolRouter<Self>,
    client: reqwest::Client,
    base_url: String,
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
            client: reqwest::Client::new(),
            base_url,
        }
    }

    #[tool(description = "Type keystrokes into a terminal pane. Use \\n for Enter, \\r for Return, \\t for Tab. These are unescaped automatically. Address panes with window/tab/pane. Use terminal_status to see the hierarchy.")]
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

    #[tool(description = "Run a shell command in a terminal pane. Sends command + Enter, waits, returns screen content. Address panes with window/tab/pane. Use terminal_status to see the hierarchy.")]
    async fn terminal_run(
        &self,
        Parameters(req): Parameters<RunRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        self.focus_pane(req.window, req.tab.as_deref(), req.pane.as_deref()).await;
        // Strip trailing newline/return sequences agents love to append — we add our own Enter
        let cmd = strip_trailing_returns(&req.command);
        let keys = format!("{}\r\n", cmd);
        self.post_text(&self.pane_path("/api/type", req.window, req.tab.as_deref(), req.pane.as_deref()), &keys).await?;

        let wait = req.wait_ms.unwrap_or(2000);
        tokio::time::sleep(tokio::time::Duration::from_millis(wait)).await;

        let text = self.get(&self.pane_path("/api/screen", req.window, req.tab.as_deref(), req.pane.as_deref())).await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    #[tool(description = "Read the current screen content of a terminal pane. Address panes with window/tab/pane. Use terminal_status to see the hierarchy.")]
    async fn terminal_screen(
        &self,
        Parameters(req): Parameters<ScreenRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let text = self.get(&self.pane_path("/api/screen", req.window, req.tab.as_deref(), req.pane.as_deref())).await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    #[tool(description = "List all open windows, tabs, and panes in a nested hierarchy. Each window has tabs, each tab has panes labeled a, b, c if split. Use window/tab/pane to address targets in other tools.")]
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

    #[tool(description = "Focus a specific pane by window/tab/pane address. Use terminal_status to see the hierarchy.")]
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

    #[tool(description = "Read sidecar logs.")]
    async fn sidecar_logs(&self) -> Result<CallToolResult, ErrorData> {
        let text = self.get("/api/logs").await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
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

    #[tool(description = "Read all pane screens across all windows and tabs. Returns labeled output grouped by window and tab. Great for getting a holistic view of everything.")]
    async fn tab_snapshot(&self) -> Result<CallToolResult, ErrorData> {
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
                                let cols = pane["cols"].as_u64().unwrap_or(0);
                                let rows = pane["rows"].as_u64().unwrap_or(0);
                                let screen = self.get(&self.pane_path("/api/screen", Some(win_id as u32), Some(tab_name), Some(label))).await
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
        Ok(CallToolResult::success(vec![Content::text(output)]))
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
                                let tab_name = tab["name"].as_str().unwrap_or("shell");
                                let screen = self.get(&self.pane_path("/api/screen", Some(win["id"].as_u64().unwrap_or(0) as u32), Some(tab_name), Some(label))).await
                                    .unwrap_or_default();

                                let state = detect_shell_state(&screen);
                                results.push(serde_json::json!({
                                    "window": win["id"],
                                    "tab": tab_name,
                                    "pane": label,
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
                                let screen = self.get(&self.pane_path("/api/screen", Some(win["id"].as_u64().unwrap_or(0) as u32), Some(tab_name), Some(label))).await
                                    .unwrap_or_default();
                                let state = detect_shell_state(&screen);

                                let pane_desc = if label.is_empty() {
                                    tab_name.to_string()
                                } else {
                                    format!("{} ({})", tab_name, label)
                                };

                                if let Some(keys) = &state.actionable {
                                    self.post_text(&self.pane_path("/api/type", Some(win["id"].as_u64().unwrap_or(0) as u32), Some(tab_name), Some(label)), keys).await?;
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

    #[tool(description = "Auto-describe a pane using local ollama. Reads screen content, generates a short description, and stores it on the tab.")]
    async fn auto_describe(
        &self,
        Parameters(req): Parameters<AutoDescribeRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let resp = self.post_text(&self.pane_path("/api/pane/describe", req.window, req.tab.as_deref(), req.pane.as_deref()), "").await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
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

fn unescape_keys(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push_str("\r\n"), // \n → Enter (CR+LF for terminal)
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('\\') => out.push('\\'),
                Some(other) => { out.push('\\'); out.push(other); }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
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
            actionable: Some("\r\n".into()),
        };
    }

    // Update available prompt (codex/nemesis8)
    if lower.contains("update available") && lower.contains("skip") {
        return ShellStateInfo {
            kind: "dialog".into(),
            detail: "Update available prompt".into(),
            actionable: Some("2\r\n".into()),
        };
    }

    // Generic y/n prompt
    if lower.contains("[y/n]") || lower.contains("(y/n)") {
        return ShellStateInfo {
            kind: "dialog".into(),
            detail: "y/n confirmation".into(),
            actionable: Some("y\r\n".into()),
        };
    }

    // Press enter to continue
    if lower.contains("press enter to continue") || lower.contains("press any key") {
        return ShellStateInfo {
            kind: "dialog".into(),
            detail: "Press enter prompt".into(),
            actionable: Some("\r\n".into()),
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
        let resp = self.client
            .post(format!("{}{}", self.base_url, path))
            .body(body.to_string())
            .send()
            .await
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
                 window (index), tab (name), and pane (label) parameters: \
                 - Omit all three to target the focused window's active tab's first pane. \
                 - Specify window to pick a window by index (0, 1, 2...). \
                 - Specify tab to pick a tab by name (e.g. \"Capybara\"). \
                 - Specify pane to pick a split pane by label (\"a\", \"b\", \"c\"). \
                 For a full view of all pane contents, use tab_snapshot. \
                 \n\nTerminal: terminal_keys, terminal_run, terminal_screen, terminal_status, \
                 terminal_split, terminal_focus, terminal_close, terminal_new_tab, tab_snapshot, \
                 shell_state, shell_confirm. \
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
