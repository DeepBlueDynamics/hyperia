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
    /// Pane index (default: 0 = first pane)
    pub pane: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct RunRequest {
    /// Shell command to execute (Enter is appended automatically)
    pub command: String,
    /// Pane index (default: 0)
    pub pane: Option<usize>,
    /// Milliseconds to wait for output before reading screen (default: 2000)
    pub wait_ms: Option<u64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ScreenRequest {
    /// Pane index to read (default: 0)
    pub pane: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SplitRequest {
    /// Split direction: "horizontal" or "vertical" (default: vertical)
    pub direction: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct FocusRequest {
    /// Pane index to focus
    pub id: usize,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct NewTabRequest {
    /// Shell command to run after the tab opens (e.g. "cd /my/project && claude")
    pub command: Option<String>,
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
    /// Pane index to set status on. Omit for the first/active pane.
    pub pane: Option<usize>,
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
    /// Pane index (default: all panes)
    pub pane: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct AutoDescribeRequest {
    /// Pane index to auto-describe (default: 0)
    pub pane: Option<usize>,
}

// -- Stream Deck request schemas --

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct DeckButtonImageRequest {
    /// Button index (0-7)
    pub key: u8,
    /// Base64-encoded PNG or JPEG image (resized to 120x120)
    pub image_base64: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct DeckButtonColorRequest {
    /// Button index (0-7)
    pub key: u8,
    /// Red 0-255
    pub r: u8,
    /// Green 0-255
    pub g: u8,
    /// Blue 0-255
    pub b: u8,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct DeckTouchstripRequest {
    /// Text to display on the touchstrip. Scrolls if too long.
    pub text: Option<String>,
    /// Or base64-encoded PNG/JPEG image (800x100)
    pub image_base64: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct DeckBrightnessRequest {
    /// Brightness 0-100
    pub percent: u8,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct DeckKnobRequest {
    /// Encoder index (0-3). 0 = tab selector by default.
    pub encoder: u8,
    /// What this knob controls: "tabs", "brightness", "volume", or "custom"
    pub mode: String,
}

// -- MCP Server --

#[derive(Clone)]
pub struct HyperiaMcp {
    tool_router: ToolRouter<Self>,
    client: reqwest::Client,
    base_url: String,
    deck_port: u16,
}

#[tool_router]
impl HyperiaMcp {
    pub fn new(http_port: u16) -> Self {
        let deck_port = std::env::var("HYPERIA_DECK_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(9850u16);
        Self {
            tool_router: Self::tool_router(),
            client: reqwest::Client::new(),
            deck_port,
            base_url: format!("http://127.0.0.1:{}", http_port),
        }
    }

    #[tool(description = "Type keystrokes into a terminal pane. Use \\n for Enter, \\t for Tab.")]
    async fn terminal_keys(
        &self,
        Parameters(req): Parameters<KeysRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane = req.pane.unwrap_or(0);
        self.focus_pane(pane).await;
        let resp = self.post_text(&format!("/api/type/{}", pane), &req.keys).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Run a shell command. Sends command + Enter, waits, returns screen content.")]
    async fn terminal_run(
        &self,
        Parameters(req): Parameters<RunRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane = req.pane.unwrap_or(0);
        self.focus_pane(pane).await;
        let keys = format!("{}\r\n", req.command);
        self.post_text(&format!("/api/type/{}", pane), &keys).await?;

        let wait = req.wait_ms.unwrap_or(2000);
        tokio::time::sleep(tokio::time::Duration::from_millis(wait)).await;

        let text = self.get(&format!("/api/screen/{}", pane)).await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    #[tool(description = "Read the current screen content of a terminal pane.")]
    async fn terminal_screen(
        &self,
        Parameters(req): Parameters<ScreenRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let pane = req.pane.unwrap_or(0);
        let text = self.get(&format!("/api/screen/{}", pane)).await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    #[tool(description = "List all open panes with IDs, names, dimensions, and PIDs.")]
    async fn terminal_status(&self) -> Result<CallToolResult, ErrorData> {
        let text = self.get("/api/status").await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    #[tool(description = "Split the focused pane. Direction: 'horizontal' or 'vertical' (default).")]
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

    #[tool(description = "Focus a specific pane by index.")]
    async fn terminal_focus(
        &self,
        Parameters(req): Parameters<FocusRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"id": req.id});
        let resp = self.post_json("/api/pane/focus", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Close the currently focused pane.")]
    async fn terminal_close(&self) -> Result<CallToolResult, ErrorData> {
        let resp = self.post_json("/api/pane/close", &serde_json::json!({})).await?;
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

    #[tool(description = "Set the agent status light on a specific tab. Use pane to target a tab by index.")]
    async fn agent_status(
        &self,
        Parameters(req): Parameters<AgentStatusRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        // Resolve pane index to session UID if provided
        let session_uid = if let Some(pane) = req.pane {
            let status_text = self.get("/api/status").await?;
            let status: serde_json::Value = serde_json::from_str(&status_text)
                .map_err(|e| ErrorData::internal_error(format!("Parse: {e}"), None))?;
            status["panes"]
                .as_array()
                .and_then(|panes| panes.get(pane))
                .and_then(|p| p["uid"].as_str())
                .map(|s| s.to_string())
        } else {
            None
        };

        let mut body = serde_json::json!({
            "connected": req.connected,
            "working": req.working,
            "label": req.label,
            "humanPercent": req.human_percent,
        });
        if let Some(uid) = session_uid {
            body["sessionUid"] = serde_json::json!(uid);
        }
        let resp = self.post_json("/api/agent/status", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    // -- Voice (Auracle) tools --

    #[tool(description = "Get voice/mic (Auracle) status: running, service health, exe path.")]
    async fn voice_status(&self) -> Result<CallToolResult, ErrorData> {
        let text = self.get("/api/voice/status").await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    #[tool(description = "Start voice/mic capture (Auracle). Transcripts are typed into the focused pane.")]
    async fn voice_start(&self) -> Result<CallToolResult, ErrorData> {
        let resp = self.post_json("/api/voice/start", &serde_json::json!({})).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Stop voice/mic capture (Auracle).")]
    async fn voice_stop(&self) -> Result<CallToolResult, ErrorData> {
        let resp = self.post_json("/api/voice/stop", &serde_json::json!({})).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Toggle voice/mic capture on/off.")]
    async fn voice_toggle(&self) -> Result<CallToolResult, ErrorData> {
        let resp = self.post_json("/api/voice/toggle", &serde_json::json!({})).await?;
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

    #[tool(description = "Read all pane screens in the current tab at once. Returns labeled output for each visible pane.")]
    async fn tab_snapshot(&self) -> Result<CallToolResult, ErrorData> {
        let status_text = self.get("/api/status").await?;
        let status: serde_json::Value = serde_json::from_str(&status_text)
            .map_err(|e| ErrorData::internal_error(format!("Parse: {e}"), None))?;

        let mut output = String::new();
        if let Some(panes) = status["panes"].as_array() {
            for pane in panes {
                let id = pane["id"].as_u64().unwrap_or(0);
                let name = pane["name"].as_str().unwrap_or("unknown");
                let cols = pane["cols"].as_u64().unwrap_or(0);
                let rows = pane["rows"].as_u64().unwrap_or(0);
                let screen = self.get(&format!("/api/screen/{}", id)).await
                    .unwrap_or_else(|_| "(error reading screen)".into());

                output.push_str(&format!(
                    "=== Pane {} | {} | {}x{} ===\n{}\n\n",
                    id, name, cols, rows, screen.trim()
                ));
            }
        }
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(description = "Analyze a pane's screen and return its state: idle (at prompt), dialog (waiting for selection), running (command in progress), or empty.")]
    async fn shell_state(&self) -> Result<CallToolResult, ErrorData> {
        let status_text = self.get("/api/status").await?;
        let status: serde_json::Value = serde_json::from_str(&status_text)
            .map_err(|e| ErrorData::internal_error(format!("Parse: {e}"), None))?;

        let mut results = Vec::new();
        if let Some(panes) = status["panes"].as_array() {
            for pane in panes {
                let id = pane["id"].as_u64().unwrap_or(0);
                let screen = self.get(&format!("/api/screen/{}", id)).await
                    .unwrap_or_default();

                let state = detect_shell_state(&screen);
                results.push(serde_json::json!({
                    "pane": id,
                    "state": state.kind,
                    "detail": state.detail,
                    "actionable": state.actionable,
                }));
            }
        }
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&results).unwrap()
        )]))
    }

    #[tool(description = "Auto-handle common shell prompts (trust dialogs, update prompts, y/n confirmations) on one or all panes.")]
    async fn shell_confirm(
        &self,
        Parameters(req): Parameters<ShellConfirmRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let status_text = self.get("/api/status").await?;
        let status: serde_json::Value = serde_json::from_str(&status_text)
            .map_err(|e| ErrorData::internal_error(format!("Parse: {e}"), None))?;

        let mut actions = Vec::new();
        if let Some(panes) = status["panes"].as_array() {
            for pane in panes {
                let id = pane["id"].as_u64().unwrap_or(0) as usize;
                if let Some(target) = req.pane {
                    if id != target { continue; }
                }

                let screen = self.get(&format!("/api/screen/{}", id)).await
                    .unwrap_or_default();
                let state = detect_shell_state(&screen);

                if let Some(keys) = &state.actionable {
                    self.post_text(&format!("/api/type/{}", id), keys).await?;
                    actions.push(format!("Pane {}: sent '{}' ({})", id, keys.replace('\r', "\\r"), state.detail));
                } else {
                    actions.push(format!("Pane {}: no action needed ({})", id, state.kind));
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
        let pane = req.pane.unwrap_or(0);
        let resp = self.post_text(&format!("/api/pane/describe/{}", pane), "").await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    // -- Stream Deck tools --

    #[tool(description = "Get Stream Deck device info and state.")]
    async fn deck_info(&self) -> Result<CallToolResult, ErrorData> {
        let text = self.get_deck("/status").await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    #[tool(description = "Set a Stream Deck button image from base64 PNG/JPEG. Key 0-7.")]
    async fn deck_button_image(
        &self,
        Parameters(req): Parameters<DeckButtonImageRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"key": req.key, "image_base64": req.image_base64});
        let resp = self.post_json_deck("/button/image", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Set a Stream Deck button to a solid color. Key 0-7, RGB 0-255.")]
    async fn deck_button_color(
        &self,
        Parameters(req): Parameters<DeckButtonColorRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"key": req.key, "r": req.r, "g": req.g, "b": req.b});
        let resp = self.post_json_deck("/button/color", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Set the Stream Deck touchstrip. Provide text (scrolls if long) or base64 image.")]
    async fn deck_touchstrip(
        &self,
        Parameters(req): Parameters<DeckTouchstripRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Some(text) = &req.text {
            let body = serde_json::json!({"text": text});
            let resp = self.post_json_deck("/touchstrip/text", &body).await?;
            Ok(CallToolResult::success(vec![Content::text(resp)]))
        } else if let Some(img) = &req.image_base64 {
            let body = serde_json::json!({"image_base64": img});
            let resp = self.post_json_deck("/touchstrip/image", &body).await?;
            Ok(CallToolResult::success(vec![Content::text(resp)]))
        } else {
            Ok(CallToolResult::error(vec![Content::text("Provide text or image_base64")]))
        }
    }

    #[tool(description = "Set Stream Deck brightness 0-100.")]
    async fn deck_brightness(
        &self,
        Parameters(req): Parameters<DeckBrightnessRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"percent": req.percent});
        let resp = self.post_json_deck("/brightness", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Configure a Stream Deck knob. Encoder 0-3, mode: tabs/brightness/volume/custom.")]
    async fn deck_knob(
        &self,
        Parameters(req): Parameters<DeckKnobRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = serde_json::json!({"encoder": req.encoder, "mode": req.mode});
        let resp = self.post_json_deck("/encoder/mode", &body).await?;
        Ok(CallToolResult::success(vec![Content::text(resp)]))
    }

    #[tool(description = "Take a screenshot of the Stream Deck. Returns base64 PNG.")]
    async fn deck_screenshot(&self) -> Result<CallToolResult, ErrorData> {
        let text = self.get_deck("/screenshot").await?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }
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
    /// Focus a pane by index (fire-and-forget, best-effort).
    async fn focus_pane(&self, pane: usize) {
        let body = serde_json::json!({"id": pane});
        let _ = self.post_json("/api/pane/focus", &body).await;
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

    fn deck_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.deck_port)
    }

    async fn get_deck(&self, path: &str) -> Result<String, ErrorData> {
        let resp = self.client
            .get(format!("{}{}", self.deck_url(), path))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Deck HTTP: {e}"), None))?;
        resp.text().await
            .map_err(|e| ErrorData::internal_error(format!("Deck read: {e}"), None))
    }

    async fn post_json_deck(&self, path: &str, body: &serde_json::Value) -> Result<String, ErrorData> {
        let resp = self.client
            .post(format!("{}{}", self.deck_url(), path))
            .json(body)
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Deck HTTP: {e}"), None))?;
        resp.text().await
            .map_err(|e| ErrorData::internal_error(format!("Deck read: {e}"), None))
    }
}

// -- ServerHandler impl --

#[tool_handler]
impl ServerHandler for HyperiaMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            instructions: Some(
                "Hyperia MCP server. Controls a running Hyperia terminal emulator. \
                 Tools: terminal_keys, terminal_run, terminal_screen, terminal_status, \
                 terminal_split, terminal_focus, terminal_close, terminal_new_tab, \
                 sidecar_logs, agent_status, \
                 voice_status, voice_start, voice_stop, voice_toggle, \
                 style_list, style_create, style_delete, \
                 telemetry_toggle, telemetry_snapshot, telemetry_record, telemetry_reset, \
                 dashboard_widgets, tab_snapshot, shell_state, shell_confirm, \
                 deck_info, deck_button_image, deck_button_color, deck_touchstrip, \
                 deck_brightness, deck_knob, deck_screenshot."
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
