use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use super::ferricula::FerriculaBackend;
use super::types::ToolDef;

/// Response from the renderer to a pending show_* tool call.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiResponse {
    /// User submitted a value (text, picked option, button clicked).
    Value(serde_json::Value),
    /// User dismissed the widget without submitting.
    Dismissed,
}

/// How a dynamic tool is invoked.
#[derive(Debug, Clone)]
pub enum DynamicInvocation {
    /// Legacy: shell command with {{input.field}} substitution
    ShellTemplate(String),
    /// Script file on disk — receives JSON args on stdin, writes result to stdout
    Script { path: String, interpreter: String },
}

/// A dynamically created tool.
#[derive(Debug, Clone)]
pub struct DynamicTool {
    pub def: ToolDef,
    pub invocation: DynamicInvocation,
}

pub struct ToolRegistry {
    builtins: Vec<ToolDef>,
    dynamic: Arc<Mutex<Vec<DynamicTool>>>,
    client: reqwest::Client,
    http_port: u16,
    ferricula: Option<Arc<FerriculaBackend>>,
    compressor: crate::ghost::compressor::ContextCompressor,
    /// Map from show_* tool widget id → oneshot sender. When the renderer
    /// POSTs to /api/ghost/ui-response, the matching sender fires and the
    /// tool dispatch's await returns.
    pending_ui: Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<UiResponse>>>>,
}

impl ToolRegistry {
    pub fn new(http_port: u16) -> Self {
        Self {
            builtins: builtin_tool_defs(),
            dynamic: Arc::new(Mutex::new(Vec::new())),
            client: reqwest::Client::new(),
            http_port,
            ferricula: None,
            compressor: crate::ghost::compressor::ContextCompressor::from_env(),
            pending_ui: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Called by the HTTP handler when the renderer submits a ui_response.
    /// Returns true if the id matched a pending widget.
    pub async fn resolve_ui_response(&self, id: &str, response: UiResponse) -> bool {
        let mut map = self.pending_ui.lock().await;
        match map.remove(id) {
            Some(tx) => tx.send(response).is_ok(),
            None => false,
        }
    }

    /// Show a widget and block until the user responds. The tool_use the
    /// agent emitted (with the widget id in its input) is what the renderer
    /// sees via the SSE event stream; this just registers the awaiter.
    async fn await_ui_response(&self, id: &str) -> UiResponse {
        let (tx, rx) = oneshot::channel();
        {
            let mut map = self.pending_ui.lock().await;
            map.insert(id.to_string(), tx);
        }
        match rx.await {
            Ok(r) => r,
            // Sender dropped — treat as dismissed. Happens on shutdown.
            Err(_) => UiResponse::Dismissed,
        }
    }

    pub fn with_ferricula(mut self, fc: Arc<FerriculaBackend>) -> Self {
        self.ferricula = Some(fc.clone());
        self.compressor = self.compressor.with_ferricula(fc);
        self
    }

    /// All tool definitions for sending to the Anthropic API.
    pub fn tool_defs(&self) -> Vec<ToolDef> {
        let mut defs = self.builtins.clone();
        defs.push(tool_search_def());
        defs.push(tool_create_def());
        defs.push(watercooler_def());
        // Ferricula memory tools
        defs.push(memory_recall_def());
        defs.push(memory_remember_def());
        defs.push(memory_dream_def());
        defs.push(memory_connect_def());
        defs.push(memory_status_def());
        defs.push(memory_sql_def());
        defs.push(memory_inspect_def());
        defs.push(memory_keystone_def());
        defs.push(memory_neighbors_def());
        defs.push(memory_embody_def());
        // Inline-UI tools — show a widget in the chat and block until the
        // user submits a value (or dismisses it).
        defs.push(show_input_def());
        defs.push(show_button_def());
        defs.push(show_picker_def());
        // Readiness probe — used at session start by the config agent.
        defs.push(doctor_def());
        defs.push(model_catalog_def());
        defs.push(maximus_explain_def());
        let dynamic = self.dynamic.lock().unwrap();
        for dt in dynamic.iter() {
            defs.push(dt.def.clone());
        }
        defs
    }

    /// Execute a tool by name with the given input.
    ///
    /// Tool results pass through Maximus when `focus=` (extract specific info) or
    /// `raw=true` (bypass with annotation) is provided. Results include a [tokenmax …]
    /// header explaining what happened and hinting at available params.
    pub async fn execute(&self, name: &str, input: &serde_json::Value) -> String {
        // Internal tools bypass Maximus entirely
        match name {
            "tool_search" => return self.handle_tool_search(input),
            "tool_create" => return self.handle_tool_create(input),
            "watercooler" => {
                let msg = input["message"].as_str().unwrap_or("Checking in");
                return format!("Yielding to human: {}", msg);
            }
            "memory_recall" => return self.handle_memory_recall(input).await,
            "memory_remember" => return self.handle_memory_remember(input).await,
            "memory_status" => return self.handle_memory_status().await,
            "memory_dream" => return self.handle_memory_dream().await,
            "memory_connect" => return self.handle_memory_connect(input).await,
            "memory_sql" => return self.handle_memory_sql(input).await,
            "memory_inspect" => return self.handle_memory_inspect(input).await,
            "memory_keystone" => return self.handle_memory_keystone(input).await,
            "memory_neighbors" => return self.handle_memory_neighbors(input).await,
            "memory_embody" => return self.handle_memory_embody().await,
            "show_input" => return self.handle_show(input, "input").await,
            "show_button" => return self.handle_show(input, "button").await,
            "show_picker" => return self.handle_show(input, "picker").await,
            "doctor" => return run_doctor().await.to_string(),
            "model_catalog" => return model_catalog(input),
            "maximus_explain" => return self.compressor.explain_last().await,
            _ => {}
        }

        let result = if self.is_builtin(name) {
            self.execute_builtin(name, input).await
        } else {
            self.execute_dynamic(name, input).await
        };

        let focus = input["focus"].as_str().unwrap_or("").trim().to_string();
        let raw = input["raw"].as_bool().unwrap_or(false);
        let focus_used = !focus.is_empty();

        if raw || focus_used {
            let mr = self.compressor.extract_maximus(&result, &focus, raw).await;
            let annotation = crate::ghost::compressor::ContextCompressor::format_annotation(
                &mr.meta, focus_used, raw,
            );
            return if annotation.is_empty() {
                mr.content
            } else {
                format!("{}{}", annotation, mr.content)
            };
        }

        result
    }

    async fn handle_memory_recall(&self, input: &serde_json::Value) -> String {
        let query = input["query"].as_str().unwrap_or("");
        match &self.ferricula {
            Some(fc) => {
                let result = fc.recall(query).await;
                if result.is_empty() { "No memories found.".into() } else { result }
            }
            None => "Ferricula not configured.".into(),
        }
    }

    async fn handle_memory_remember(&self, input: &serde_json::Value) -> String {
        let text = input["text"].as_str().unwrap_or("");
        let channel = input["channel"].as_str().unwrap_or("ghost");
        if text.is_empty() { return "Error: 'text' is required.".into(); }
        let importance = input["importance"].as_f64().unwrap_or(0.5) as f32;
        let keystone = input["keystone"].as_bool().unwrap_or(false);
        let emotion = input["emotion"].as_str().map(|e| (e, input["emotion_secondary"].as_str()));
        match &self.ferricula {
            Some(fc) => {
                fc.remember_full(text, channel, importance, emotion, keystone).await;
                let extras = if keystone { " [keystone]" } else { "" };
                format!("Remembered (importance={:.1}){}:{}", importance, extras, &text[..text.len().min(100)])
            }
            None => "Ferricula not configured.".into(),
        }
    }

    async fn handle_memory_dream(&self) -> String {
        match &self.ferricula {
            Some(fc) => fc.dream().await,
            None => "Ferricula not configured.".into(),
        }
    }

    async fn handle_memory_connect(&self, input: &serde_json::Value) -> String {
        let id_a = input["id_a"].as_u64().unwrap_or(0) as u32;
        let id_b = input["id_b"].as_u64().unwrap_or(0) as u32;
        let label = input["label"].as_str().unwrap_or("related");
        if id_a == 0 || id_b == 0 { return "Error: id_a and id_b are required.".into(); }
        match &self.ferricula {
            Some(fc) => fc.connect(id_a, id_b, label).await,
            None => "Ferricula not configured.".into(),
        }
    }

    async fn handle_memory_status(&self) -> String {
        match &self.ferricula {
            Some(fc) => {
                let info = fc.config_json();
                serde_json::to_string_pretty(&info).unwrap_or_else(|_| "{}".into())
            }
            None => "Ferricula not configured.".into(),
        }
    }

    async fn handle_memory_sql(&self, input: &serde_json::Value) -> String {
        let sql = input["sql"].as_str().unwrap_or("");
        if sql.is_empty() {
            return "Error: 'sql' is required.".into();
        }
        match &self.ferricula {
            Some(fc) => fc.sql(sql).await,
            None => "Ferricula not configured.".into(),
        }
    }

    async fn handle_memory_inspect(&self, input: &serde_json::Value) -> String {
        let id = input["id"].as_u64().unwrap_or(0) as u32;
        if id == 0 {
            return "Error: 'id' is required.".into();
        }
        match &self.ferricula {
            Some(fc) => fc.inspect(id).await,
            None => "Ferricula not configured.".into(),
        }
    }

    async fn handle_memory_keystone(&self, input: &serde_json::Value) -> String {
        let id = input["id"].as_u64().unwrap_or(0) as u32;
        if id == 0 {
            return "Error: 'id' is required.".into();
        }
        match &self.ferricula {
            Some(fc) => fc.keystone(id).await,
            None => "Ferricula not configured.".into(),
        }
    }

    async fn handle_memory_neighbors(&self, input: &serde_json::Value) -> String {
        let id = input["id"].as_u64().unwrap_or(0) as u32;
        if id == 0 {
            return "Error: 'id' is required.".into();
        }
        match &self.ferricula {
            Some(fc) => fc.neighbors(id).await,
            None => "Ferricula not configured.".into(),
        }
    }

    async fn handle_memory_embody(&self) -> String {
        match &self.ferricula {
            Some(fc) => fc.embody().await,
            None => "Ferricula not configured.".into(),
        }
    }

    /// Common handler for show_input / show_button / show_picker.
    ///
    /// The agent emits a tool_use with the widget id in `input.id`. We
    /// register a oneshot keyed by that id, then await. The renderer renders
    /// the widget (driven by the tool_use it sees via SSE) and POSTs the
    /// user's response to /api/ghost/ui-response, which resolves the
    /// oneshot. The returned string becomes the tool_result the agent sees.
    async fn handle_show(&self, input: &serde_json::Value, kind: &str) -> String {
        let id = input["id"].as_str().unwrap_or("").trim();
        if id.is_empty() {
            return serde_json::json!({
                "error": format!("show_{} requires a non-empty 'id' field", kind)
            })
            .to_string();
        }
        let response = self.await_ui_response(id).await;
        match response {
            UiResponse::Value(v) => serde_json::json!({
                "ui_response": { "id": id, "value": v }
            })
            .to_string(),
            UiResponse::Dismissed => serde_json::json!({
                "ui_response": { "id": id, "dismissed": true }
            })
            .to_string(),
        }
    }

    fn is_builtin(&self, name: &str) -> bool {
        self.builtins.iter().any(|t| t.name == name)
    }

    fn handle_tool_search(&self, input: &serde_json::Value) -> String {
        let query = input["query"].as_str().unwrap_or("").to_lowercase();
        let all_defs = self.tool_defs();
        let matches: Vec<_> = all_defs
            .iter()
            .filter(|t| {
                t.name.to_lowercase().contains(&query)
                    || t.description.to_lowercase().contains(&query)
            })
            .map(|t| format!("- {}: {}", t.name, t.description))
            .collect();

        if matches.is_empty() {
            format!("No tools found matching '{}'", query)
        } else {
            format!("Found {} tool(s):\n{}", matches.len(), matches.join("\n"))
        }
    }

    fn handle_tool_create(&self, input: &serde_json::Value) -> String {
        let name = match input["name"].as_str() {
            Some(n) => n.to_string(),
            None => return "Error: 'name' is required".into(),
        };
        let description = input["description"]
            .as_str()
            .unwrap_or("A dynamically created tool")
            .to_string();
        let parameters = input["parameters"].clone();
        let schema = if parameters.is_null() || (parameters.is_object() && parameters.as_object().map_or(true, |o| o.is_empty())) {
            serde_json::json!({ "type": "object", "properties": {} })
        } else {
            parameters
        };

        let invocation = if let Some(code) = input["code"].as_str() {
            // Script-based tool — write to ~/.hyperia/tools/<name>.<ext>
            let language = input["language"].as_str().unwrap_or("python");
            let ext = match language {
                "node" | "javascript" | "js" => "js",
                "shell" | "bash" | "sh"      => "sh",
                _                            => "py",
            };
            let interpreter = match language {
                "node" | "javascript" | "js" => "node",
                "shell" | "bash" | "sh"      => if cfg!(windows) { "bash" } else { "bash" },
                _                            => "python3",
            };

            let tools_dir = Self::tools_dir();
            if let Err(e) = std::fs::create_dir_all(&tools_dir) {
                return format!("Error creating tools dir: {}", e);
            }
            let script_path = tools_dir.join(format!("{}.{}", name, ext));
            if let Err(e) = std::fs::write(&script_path, code) {
                return format!("Error writing script: {}", e);
            }
            // Make executable on Unix
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755));
            }
            DynamicInvocation::Script {
                path: script_path.to_string_lossy().to_string(),
                interpreter: interpreter.to_string(),
            }
        } else if let Some(command) = input["command"].as_str() {
            DynamicInvocation::ShellTemplate(command.to_string())
        } else {
            return "Error: provide either 'code' (script) or 'command' (shell template)".into();
        };

        let summary = match &invocation {
            DynamicInvocation::Script { path, interpreter } =>
                format!("Script tool '{}' written ({}) — call it now.", name, interpreter),
            DynamicInvocation::ShellTemplate(_) =>
                format!("Shell tool '{}' created — call it now.", name),
        };

        let tool = DynamicTool {
            def: ToolDef { name: name.clone(), description, input_schema: schema },
            invocation,
        };

        let mut dynamic = self.dynamic.lock().unwrap();
        dynamic.retain(|t| t.def.name != name);
        dynamic.push(tool);

        summary
    }

    fn tools_dir() -> std::path::PathBuf {
        let home = if cfg!(windows) {
            std::env::var("USERPROFILE").unwrap_or_default()
        } else {
            std::env::var("HOME").unwrap_or_default()
        };
        std::path::PathBuf::from(home).join(".hyperia").join("tools")
    }

    async fn execute_dynamic(&self, name: &str, input: &serde_json::Value) -> String {
        let tool = {
            let dynamic = self.dynamic.lock().unwrap();
            match dynamic.iter().find(|t| t.def.name == name) {
                Some(t) => t.clone(),
                None => return format!("Unknown tool: {}", name),
            }
        };

        match &tool.invocation {
            DynamicInvocation::Script { path, interpreter } => {
                // Pass args as JSON on stdin; read result from stdout
                let args_json = serde_json::to_string(input).unwrap_or_else(|_| "{}".into());
                let mut child = match tokio::process::Command::new(interpreter)
                    .arg(path)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                {
                    Ok(c) => c,
                    Err(e) => return format!("Failed to start {}: {}", interpreter, e),
                };
                // Write JSON args to stdin
                if let Some(mut stdin) = child.stdin.take() {
                    use tokio::io::AsyncWriteExt;
                    let _ = stdin.write_all(args_json.as_bytes()).await;
                }
                let out = match child.wait_with_output().await {
                    Ok(o) => o,
                    Err(e) => return format!("Script execution error: {}", e),
                };
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if out.status.success() {
                    if stdout.is_empty() && !stderr.is_empty() { stderr } else { stdout }
                } else {
                    format!("Script failed (exit {}):\n{}{}", out.status.code().unwrap_or(-1),
                        if !stdout.is_empty() { format!("stdout: {}\n", stdout) } else { String::new() },
                        if !stderr.is_empty() { format!("stderr: {}", stderr) } else { String::new() })
                }
            }

            DynamicInvocation::ShellTemplate(template) => {
                // Legacy: substitute {{input.fieldName}} and run as shell command
                let mut cmd = template.clone();
                if let Some(obj) = input.as_object() {
                    for (key, val) in obj {
                        let placeholder = format!("{{{{input.{}}}}}", key);
                        let replacement = match val {
                            serde_json::Value::String(s) => s.clone(),
                            other => other.to_string(),
                        };
                        cmd = cmd.replace(&placeholder, &replacement);
                    }
                }
                match tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
                    .args(if cfg!(windows) { vec!["/c", &cmd] } else { vec!["-c", &cmd] })
                    .output()
                    .await
                {
                    Ok(output) => {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        if output.status.success() {
                            if stderr.is_empty() { stdout.to_string() }
                            else { format!("{}\nstderr: {}", stdout, stderr) }
                        } else {
                            format!("Command failed (exit {}):\nstdout: {}\nstderr: {}",
                                output.status.code().unwrap_or(-1), stdout, stderr)
                        }
                    }
                    Err(e) => format!("Failed to execute command: {}", e),
                }
            }
        }
    }

    /// Read the screen from a pane and return just the text lines.
    async fn read_screen(&self, url: &str) -> String {
        match self.client.get(url).send().await {
            Ok(resp) => {
                let text = resp.text().await.unwrap_or_default();
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                    let lines: Vec<&str> = json["lines"]
                        .as_array()
                        .map(|arr| arr.iter().filter_map(|l| l["text"].as_str()).collect())
                        .unwrap_or_default();
                    lines.join("\n")
                } else {
                    text
                }
            }
            Err(e) => format!("Screen read error: {}", e),
        }
    }

    /// Execute a built-in tool by calling the sidecar HTTP API.
    async fn execute_builtin(&self, name: &str, input: &serde_json::Value) -> String {
        // Electron-side actions — return sentinel without HTTP round-trip
        if name == "open_settings" {
            return "ACTION:open_settings".into();
        }

        let base = format!("http://localhost:{}", self.http_port);

        let build_target_url = |path: &str| {
            let mut url = format!("{}/{}", base, path.trim_start_matches('/'));
            let mut params = Vec::new();
            if let Some(window) = input["window"].as_u64() {
                params.push(format!("window={}", window));
            }
            if let Some(tab) = input["tab"].as_str() {
                params.push(format!("tab={}", urlencoding::encode(tab)));
            }
            if let Some(pane) = input["pane"].as_str() {
                params.push(format!("pane={}", urlencoding::encode(pane)));
            }
            if !params.is_empty() {
                url.push('?');
                url.push_str(&params.join("&"));
            }
            url
        };

        // For terminal_keys and terminal_run: read the screen FIRST to detect interactive programs
        if name == "terminal_keys" || name == "terminal_run" {
            let screen_before = self.read_screen(&build_target_url("/api/screen")).await;
            let interactive = detect_interactive(&screen_before);

            if let Some(_program) = &interactive {
                // Interactive program detected — terminal_run will send text as keystrokes (same as terminal_keys)
                // No block: let terminal_run fall through and send command + \r naturally
            }
        }

        let result = match name {
            "terminal_keys" => {
                let keys = input["keys"].as_str().unwrap_or("");
                let keys = unescape_keys(keys);
                match self.client
                    .post(build_target_url("/api/type-and-collect"))
                    .body(keys)
                    .send()
                    .await
                {
                    Ok(resp) => return resp.text().await.unwrap_or_default(),
                    Err(e) => return format!("Error: {}", e),
                }
            }
            "terminal_run" => {
                let command = input["command"].as_str().unwrap_or("");
                let submit = input["submit"].as_bool().unwrap_or(true);
                let wait_ms = input["wait_ms"].as_u64().unwrap_or(if submit { 2000 } else { 200 });
                let command = command.trim_end_matches('\n').trim_end_matches('\r');
                // Send text first, then Enter as a separate write
                let _ = self.client
                    .post(build_target_url("/api/type"))
                    .body(command.to_string())
                    .send()
                    .await;
                if submit {
                    let _ = self.client
                        .post(build_target_url("/api/type"))
                        .body("\r")
                        .send()
                        .await;
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(wait_ms)).await;
                return self.read_screen(&build_target_url("/api/screen")).await;
            }
            "terminal_split" => {
                // If a label is given, focus that pane first
                if let Some(label) = input["label"].as_str() {
                    let _ = self.client
                        .post(format!("{}/api/pane/focus", base))
                        .json(&serde_json::json!({ "pane": label }))
                        .send()
                        .await;
                    tokio::time::sleep(tokio::time::Duration::from_millis(80)).await;
                }
                let dir = input["direction"].as_str().unwrap_or("vertical");
                let body = serde_json::json!({ "direction": dir });
                self.client
                    .post(format!("{}/api/pane/split", base))
                    .json(&body)
                    .send()
                    .await
            }
            "terminal_focus" => {
                let body = serde_json::json!({
                    "window": input["window"],
                    "tab": input["tab"],
                    "pane": input["pane"],
                });
                self.client
                    .post(format!("{}/api/pane/focus", base))
                    .json(&body)
                    .send()
                    .await
            }
            "terminal_rename" => {
                let tab_name = input["name"].as_str().unwrap_or("unnamed");
                let body = serde_json::json!({
                    "name": tab_name,
                    "window": input["window"],
                    "tab": input["tab"],
                });
                self.client
                    .post(format!("{}/api/pane/rename", base))
                    .json(&body)
                    .send()
                    .await
            }
            "terminal_where_pane" => {
                let a = input["a"].as_str().unwrap_or("");
                let b = input["b"].as_str().unwrap_or("");
                match self.client
                    .get(format!("{}/api/pane/where?a={}&b={}", base, a, b))
                    .send()
                    .await
                {
                    Ok(resp) => return resp.text().await.unwrap_or_default(),
                    Err(e) => return format!("Error: {}", e),
                }
            }
            "terminal_new_window" => {
                self.client
                    .post(format!("{}/api/window/new", base))
                    .json(&serde_json::json!({}))
                    .send()
                    .await
            }
            "terminal_new_tab" => {
                let body = serde_json::json!({
                    "profile": input["profile"],
                    "command": input["command"],
                });
                self.client
                    .post(format!("{}/api/pane/new", base))
                    .json(&body)
                    .send()
                    .await
            }
            "terminal_close" => {
                let body = serde_json::json!({ "uid": input["uid"] });
                self.client
                    .post(format!("{}/api/pane/close", base))
                    .json(&body)
                    .send()
                    .await
            }
            "terminal_status" => self.client.get(format!("{}/api/status", base)).send().await,
            "terminal_screen" => {
                match self
                    .client
                    .get(build_target_url("/api/screen"))
                    .send()
                    .await
                {
                    Ok(resp) => {
                        let text = resp.text().await.unwrap_or_default();
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                            let lines: Vec<&str> = json["lines"]
                                .as_array()
                                .map(|arr| {
                                    arr.iter().filter_map(|l| l["text"].as_str()).collect()
                                })
                                .unwrap_or_default();
                            return lines.join("\n");
                        }
                        return text;
                    }
                    Err(e) => return format!("HTTP error: {}", e),
                }
            }
            "file_read" => {
                let path = input["path"].as_str().unwrap_or("");
                let max_lines = input["max_lines"].as_u64().unwrap_or(200).min(1000) as usize;
                match std::fs::read_to_string(path) {
                    Ok(content) => {
                        let lines: Vec<&str> = content.lines().collect();
                        if lines.len() > max_lines {
                            return format!(
                                "{}\n... [{} more lines truncated]",
                                lines[..max_lines].join("\n"),
                                lines.len() - max_lines
                            );
                        }
                        return content;
                    }
                    Err(e) => return format!("Error reading file: {}", e),
                }
            }
            "file_write" => {
                let path = input["path"].as_str().unwrap_or("");
                let content = input["content"].as_str().unwrap_or("");
                let append = input["append"].as_bool().unwrap_or(false);

                if let Some(parent) = std::path::Path::new(path).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }

                let result = if append {
                    use std::io::Write;
                    std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(path)
                        .and_then(|mut f| f.write_all(content.as_bytes()))
                } else {
                    std::fs::write(path, content)
                };

                return match result {
                    Ok(()) => format!("Wrote {} bytes to {}", content.len(), path),
                    Err(e) => format!("Error writing file: {}", e),
                };
            }
            "sticky_note_create" => {
                let body = serde_json::json!({
                    "text": input["text"].as_str().unwrap_or(""),
                    "x": input["x"],
                    "y": input["y"],
                    "width": input["width"],
                    "height": input["height"],
                });
                self.client
                    .post(format!("{}/api/notes", base))
                    .json(&body)
                    .send()
                    .await
            }
            "sticky_note_create_code" => {
                let file_path = input["file_path"].as_str().unwrap_or("").to_string();
                if file_path.is_empty() {
                    return "Error: file_path is required".to_string();
                }
                // Validate the file exists before creating the note — so errors come back to the agent, not the UI
                if let Err(e) = std::fs::metadata(&file_path) {
                    return format!("Error: cannot open '{}': {}", file_path, e);
                }
                let theme = match input["theme"].as_str().unwrap_or("dark") {
                    "light" => "code:light",
                    _ => "code:dark",
                };
                let body = serde_json::json!({
                    "file_path": file_path,
                    "color": theme,
                    "x": input["x"],
                    "y": input["y"],
                    "width": input["width"].as_i64().unwrap_or(500),
                    "height": input["height"].as_i64().unwrap_or(400),
                });
                self.client
                    .post(format!("{}/api/notes", base))
                    .json(&body)
                    .send()
                    .await
            }
            "sticky_note_list" => {
                match self.client.get(format!("{}/api/notes", base)).send().await {
                    Ok(resp) => {
                        let text = resp.text().await.unwrap_or_default();
                        if let Ok(notes) = serde_json::from_str::<Vec<serde_json::Value>>(&text) {
                            let summaries: Vec<String> = notes.iter().map(|n| {
                                let id = n["id"].as_str().unwrap_or("?");
                                let full = n["text"].as_str().unwrap_or("");
                                let preview: String = full.chars().take(80).collect();
                                let preview = if full.len() > 80 { format!("{}…", preview) } else { preview };
                                format!("{}: {}", id, preview)
                            }).collect();
                            return if summaries.is_empty() {
                                "No notes.".into()
                            } else {
                                summaries.join("\n")
                            };
                        }
                        return text;
                    }
                    Err(e) => return format!("HTTP error: {}", e),
                }
            }
            "sticky_note_close" => {
                let id = input["id"].as_str().unwrap_or("");
                let body = serde_json::json!({ "id": id });
                self.client
                    .post(format!("{}/api/notes/close", base))
                    .json(&body)
                    .send()
                    .await
            }
            "sticky_note_update" => {
                let id = input["id"].as_str().unwrap_or("");
                let body = serde_json::json!({ "text": input["text"] });
                self.client
                    .patch(format!("{}/api/notes/{}", base, id))
                    .json(&body)
                    .send()
                    .await
            }
            "sticky_note_delete" => {
                let id = input["id"].as_str().unwrap_or("");
                self.client
                    .delete(format!("{}/api/notes/{}", base, id))
                    .send()
                    .await
            }
            "session_report" => {
                let note = input["note"].as_str().unwrap_or("").to_string();
                // Fetch the full session dump
                let session_json = match self.client
                    .get(format!("{}/api/ghost/session", base))
                    .send()
                    .await
                {
                    Ok(r) => r.text().await.unwrap_or_else(|_| "{}".into()),
                    Err(e) => return format!("Error fetching session: {}", e),
                };

                // Determine output path
                let out_path = if let Some(p) = input["path"].as_str().filter(|s| !s.is_empty()) {
                    std::path::PathBuf::from(p)
                } else {
                    let home = if cfg!(windows) {
                        std::env::var("USERPROFILE").unwrap_or_default()
                    } else {
                        std::env::var("HOME").unwrap_or_default()
                    };
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    std::path::PathBuf::from(home)
                        .join(".hyperia")
                        .join("reports")
                        .join(format!("{}.json", now))
                };

                if let Some(parent) = out_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }

                // Wrap with metadata
                let report = serde_json::json!({
                    "note": note,
                    "session": serde_json::from_str::<serde_json::Value>(&session_json).unwrap_or_default(),
                });
                let report_str = serde_json::to_string_pretty(&report).unwrap_or_default();

                return match std::fs::write(&out_path, &report_str) {
                    Ok(()) => format!("Report saved to {}", out_path.display()),
                    Err(e) => format!("Error saving report: {}", e),
                };
            }
            "open_web_pane" => {
                let url = input["url"].as_str().unwrap_or("").trim().to_string();
                if url.is_empty() {
                    return "Error: url is required".into();
                }
                let full_url = if url.starts_with("http://") || url.starts_with("https://") {
                    url
                } else {
                    format!("https://{}", url)
                };
                let body = serde_json::json!({ "url": full_url });
                return match self.client
                    .post(format!("{}/api/web-pane", base))
                    .json(&body)
                    .send()
                    .await
                {
                    Ok(_) => format!("Opened web pane: {}", full_url),
                    Err(e) => format!("Error: {}", e),
                };
            }
            "web_fetch" => {
                let url = input["url"].as_str().unwrap_or("");
                let method = input["method"].as_str().unwrap_or("GET");

                let mut req = match method {
                    "POST" => self.client.post(url),
                    "PUT" => self.client.put(url),
                    "DELETE" => self.client.delete(url),
                    _ => self.client.get(url),
                };

                if let Some(headers) = input["headers"].as_object() {
                    for (k, v) in headers {
                        if let Some(val) = v.as_str() {
                            req = req.header(k.as_str(), val);
                        }
                    }
                }

                if let Some(body) = input["body"].as_str() {
                    req = req.body(body.to_string());
                }

                match req.send().await {
                    Ok(resp) => {
                        let status = resp.status();
                        let body = resp.text().await.unwrap_or_default();
                        let body = if body.len() > 8000 {
                            format!("{}...[truncated at 8000 chars]", &body[..8000])
                        } else {
                            body
                        };
                        return format!("HTTP {} — {}", status, body);
                    }
                    Err(e) => return format!("Fetch error: {}", e),
                }
            }
            "tab_snapshot" => {
                let status_text = match self.client.get(format!("{}/api/status", base)).send().await {
                    Ok(r) => r.text().await.unwrap_or_default(),
                    Err(e) => return format!("Error: {}", e),
                };
                let status: serde_json::Value = match serde_json::from_str(&status_text) {
                    Ok(v) => v,
                    Err(e) => return format!("Parse error: {}", e),
                };
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
                                        let pane_key = if label.is_empty() { pane_id } else { label };
                                        let cols = pane["cols"].as_u64().unwrap_or(0);
                                        let rows = pane["rows"].as_u64().unwrap_or(0);
                                        let screen_url = format!("{}/api/screen?window={}&tab={}&pane={}",
                                            base, win_id, urlencoding::encode(tab_name), urlencoding::encode(pane_key));
                                        let screen = match self.client.get(&screen_url).send().await {
                                            Ok(r) => r.text().await.unwrap_or_default(),
                                            Err(_) => "(error reading screen)".into(),
                                        };
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
                return output;
            }
            "shell_state" => {
                let status_text = match self.client.get(format!("{}/api/status", base)).send().await {
                    Ok(r) => r.text().await.unwrap_or_default(),
                    Err(e) => return format!("Error: {}", e),
                };
                let status: serde_json::Value = match serde_json::from_str(&status_text) {
                    Ok(v) => v,
                    Err(e) => return format!("Parse error: {}", e),
                };
                let mut results = Vec::new();
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
                                        let win_id = win["id"].as_u64().unwrap_or(0);
                                        let screen_url = format!("{}/api/screen?window={}&tab={}&pane={}",
                                            base, win_id, urlencoding::encode(tab_name), urlencoding::encode(pane_key));
                                        let screen = match self.client.get(&screen_url).send().await {
                                            Ok(r) => r.text().await.unwrap_or_default(),
                                            Err(_) => String::new(),
                                        };
                                        results.push(serde_json::json!({
                                            "window": win_id,
                                            "tab": tab_name,
                                            "pane": pane_key,
                                        }));
                                        let _ = screen; // screen available for future state detection
                                    }
                                }
                            }
                        }
                    }
                }
                return serde_json::to_string_pretty(&results).unwrap_or_default();
            }
            "shell_confirm" => {
                let window = input["window"].as_u64();
                let tab = input["tab"].as_str().unwrap_or("");
                let pane = input["pane"].as_str().unwrap_or("");
                let mut url = format!("{}/api/screen", base);
                let mut params = Vec::new();
                if let Some(w) = window { params.push(format!("window={}", w)); }
                if !tab.is_empty() { params.push(format!("tab={}", urlencoding::encode(tab))); }
                if !pane.is_empty() { params.push(format!("pane={}", urlencoding::encode(pane))); }
                if !params.is_empty() { url.push('?'); url.push_str(&params.join("&")); }
                let screen = match self.client.get(&url).send().await {
                    Ok(r) => r.text().await.unwrap_or_default(),
                    Err(e) => return format!("Error: {}", e),
                };
                // Detect common confirmations and auto-answer
                let lower = screen.to_lowercase();
                let (keys, desc) = if lower.contains("(y/n)") || lower.contains("yes/no") || lower.contains("[y/n]") {
                    ("y\r", "answered y")
                } else if lower.contains("continue?") || lower.contains("proceed?") {
                    ("\r", "pressed Enter to continue")
                } else if lower.contains("trust") && lower.contains("?") {
                    ("y\r", "answered y to trust prompt")
                } else {
                    return "No actionable prompt detected".into();
                };
                let type_url = if params.is_empty() {
                    format!("{}/api/type", base)
                } else {
                    format!("{}/api/type?{}", base, params.join("&"))
                };
                match self.client.post(&type_url).body(keys).send().await {
                    Ok(_) => return format!("shell_confirm: {}", desc),
                    Err(e) => return format!("Error sending keys: {}", e),
                }
            }
            "terminal_ui_key" => {
                let body = serde_json::json!({
                    "keyCode": input["key_code"],
                    "modifiers": input["modifiers"].as_array().cloned().unwrap_or_default(),
                    "window": input["window"],
                    "tab": input["tab"],
                    "pane": input["pane"],
                });
                self.client
                    .post(format!("{}/api/ui/key", base))
                    .json(&body)
                    .send()
                    .await
            }
            "auto_describe" => {
                self.client
                    .post(build_target_url("/api/pane/describe"))
                    .body("")
                    .send()
                    .await
            }
            _ => return format!("Unknown tool: {}", name),
        };

        match result {
            Ok(resp) => resp
                .text()
                .await
                .unwrap_or_else(|e| format!("Read error: {}", e)),
            Err(e) => format!("HTTP error: {}", e),
        }
    }
}

fn tool_search_def() -> ToolDef {
    ToolDef {
        name: "tool_search".into(),
        description: "Search available tools by keyword. Returns matching tool names and descriptions. Use this to discover what tools are available.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Search keywords" }
            },
            "required": ["query"]
        }),
    }
}

fn tool_create_def() -> ToolDef {
    ToolDef {
        name: "tool_create".into(),
        description: "Create a callable tool at runtime. Two modes:\n\
            1. SCRIPT (preferred): provide 'code' + 'language' (python/node/shell). The script receives a JSON object on stdin and must write its result to stdout. Saved to ~/.hyperia/tools/ and callable immediately.\n\
            2. SHELL TEMPLATE (simple): provide 'command' with {{input.fieldName}} substitution — use only for trivial one-liners.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Tool name (snake_case)" },
                "description": { "type": "string", "description": "What the tool does" },
                "parameters": { "type": "object", "description": "JSON Schema for the tool's input parameters" },
                "code": { "type": "string", "description": "Full script code. Reads args from stdin as JSON (import json, sys; args = json.load(sys.stdin)). Writes result to stdout." },
                "language": { "type": "string", "enum": ["python", "node", "shell"], "description": "Script language (default: python)" },
                "command": { "type": "string", "description": "Shell command template for simple one-liners. Use {{input.fieldName}} for substitution." }
            },
            "required": ["name", "description"]
        }),
    }
}

/// Unescape key sequences: \n, \t, \e, ctrl+X, etc.
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
                    let hi = chars.next().unwrap_or('0');
                    let lo = chars.next().unwrap_or('0');
                    let hex: String = [hi, lo].iter().collect();
                    if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                        out.push(byte as char);
                    }
                }
                Some(other) => { out.push('\\'); out.push(other); }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    // Handle "ctrl+X" patterns — convert to control characters
    let ctrl_re_lower = "ctrl+";
    let ctrl_re_upper = "Ctrl+";
    let mut result = out.clone();
    for prefix in [ctrl_re_lower, ctrl_re_upper] {
        while let Some(pos) = result.find(prefix) {
            if pos + prefix.len() < result.len() {
                let ch = result.as_bytes()[pos + prefix.len()];
                let ctrl_char = (ch & 0x1f) as char; // ctrl+a = 0x01, ctrl+c = 0x03, etc.
                result = format!("{}{}{}", &result[..pos], ctrl_char, &result[pos + prefix.len() + 1..]);
            } else {
                break;
            }
        }
    }
    result
}

/// Detect if a terminal screen is showing an interactive program (not a shell prompt).
fn detect_interactive(screen: &str) -> Option<String> {
    let lower = screen.to_lowercase();
    let last_lines: String = screen.lines().rev().take(10).collect::<Vec<_>>().join("\n").to_lowercase();

    // Claude Code / codex
    if last_lines.contains("claude") && (last_lines.contains("❯") || last_lines.contains(">>") || last_lines.contains("transmuting")) {
        return Some("Claude Code".into());
    }
    if last_lines.contains("codex") && (last_lines.contains(">>") || last_lines.contains("❯")) {
        return Some("Codex".into());
    }
    // Python REPL
    if last_lines.contains(">>>") && lower.contains("python") {
        return Some("Python REPL".into());
    }
    // Node REPL
    if last_lines.contains("> ") && lower.contains("node") && !last_lines.contains("$") {
        return Some("Node REPL".into());
    }
    // vim/nvim
    if lower.contains("-- insert --") || lower.contains("-- normal --") || lower.contains("-- visual --") {
        return Some("vim".into());
    }
    // less/man
    if last_lines.ends_with(":") && (lower.contains("manual page") || lower.contains("(end)")) {
        return Some("less/man".into());
    }
    // nemesis8 interactive
    if last_lines.contains("nemesis") && last_lines.contains(">>") {
        return Some("Nemesis8".into());
    }
    // SSH session indicators
    if lower.contains("ssh ") && last_lines.contains("@") && last_lines.contains("$") {
        // This is actually a shell prompt over SSH — allow it
        return None;
    }

    None
}

fn watercooler_def() -> ToolDef {
    ToolDef {
        name: "watercooler".into(),
        description: "Pause and check in with the human. Call this when you've done several actions and want to sync up, share progress, or ask for direction before continuing. The conversation yields back to the human — they reply and you continue.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "message": { "type": "string", "description": "Brief status update — what you've done and what you're thinking next" }
            },
            "required": ["message"]
        }),
    }
}

fn memory_recall_def() -> ToolDef {
    ToolDef {
        name: "memory_recall".into(),
        description: "Search your Ferricula memory for relevant memories. Use this to remember things from past conversations, facts about the user, or context you've stored.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "What to search for in memory" }
            },
            "required": ["query"]
        }),
    }
}

fn memory_remember_def() -> ToolDef {
    ToolDef {
        name: "memory_remember".into(),
        description: "Store something in your Ferricula memory. You control importance, emotion, and whether it's a keystone (permanent) memory.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "The memory to store" },
                "channel": { "type": "string", "description": "Category: ghost, user, project, etc. (default: ghost)" },
                "importance": { "type": "number", "description": "0.0-1.0 how important (default 0.5)" },
                "keystone": { "type": "boolean", "description": "If true, this memory never decays" },
                "emotion": { "type": "string", "description": "Primary emotion: curiosity, joy, concern, determination, etc." },
                "emotion_secondary": { "type": "string", "description": "Secondary emotion (optional)" }
            },
            "required": ["text"]
        }),
    }
}

fn memory_dream_def() -> ToolDef {
    ToolDef {
        name: "memory_dream".into(),
        description: "Trigger a dream cycle — consolidate and clean up memories. Merges similar memories, decays old ones, activates archetypes. Do this when cognitive heat is high or after many memories have accumulated.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {}
        }),
    }
}

fn memory_connect_def() -> ToolDef {
    ToolDef {
        name: "memory_connect".into(),
        description: "Create a semantic link between two memories by their IDs. Use this to build associations between related concepts.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "id_a": { "type": "integer", "description": "First memory ID" },
                "id_b": { "type": "integer", "description": "Second memory ID" },
                "label": { "type": "string", "description": "Relationship label (e.g. 'related', 'causes', 'contradicts')" }
            },
            "required": ["id_a", "id_b"]
        }),
    }
}

fn memory_status_def() -> ToolDef {
    ToolDef {
        name: "memory_status".into(),
        description: "Check the status of your Ferricula memory system — mode, data location, whether it's active.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {}
        }),
    }
}

fn memory_sql_def() -> ToolDef {
    ToolDef {
        name: "memory_sql".into(),
        description: "Run a SQL query against your Ferricula memory store. Use this when recall \
            isn't enough — for example to list all memories on a channel, count by tag, or join \
            across tags. The memory store exposes columns including id, text, channel, role, source, \
            importance, keystone. Example: SELECT text FROM memories WHERE channel = 'thinking' \
            ORDER BY id DESC LIMIT 20."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "sql": { "type": "string", "description": "The SQL query to run" }
            },
            "required": ["sql"]
        }),
    }
}

fn memory_inspect_def() -> ToolDef {
    ToolDef {
        name: "memory_inspect".into(),
        description: "Inspect a single memory by id — returns the full row including all tags, \
            vector status, importance, keystone flag, and connections. Use this after recall when \
            you want the full context of a specific hit."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "id": { "type": "integer", "description": "Memory ID to inspect" }
            },
            "required": ["id"]
        }),
    }
}

fn memory_keystone_def() -> ToolDef {
    ToolDef {
        name: "memory_keystone".into(),
        description: "Mark a memory as a keystone — protects it from decay during dream cycles. \
            Use this for memories that should persist permanently (core facts about the user, \
            project, or recurring patterns)."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "id": { "type": "integer", "description": "Memory ID to mark as keystone" }
            },
            "required": ["id"]
        }),
    }
}

fn memory_neighbors_def() -> ToolDef {
    ToolDef {
        name: "memory_neighbors".into(),
        description: "List the graph neighbors of a memory — connected memories and the edge \
            labels between them. Use this after recall to explore associations and traverse the \
            memory graph."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "id": { "type": "integer", "description": "Memory ID whose neighbors to list" }
            },
            "required": ["id"]
        }),
    }
}

fn show_input_def() -> ToolDef {
    ToolDef {
        name: "show_input".into(),
        description: "Render a single-line text input widget inline in the chat and BLOCK \
            until the user submits a value (or dismisses). The tool result is the value the \
            user typed, wrapped as { ui_response: { id, value } } — or { ui_response: { id, \
            dismissed: true } } if they closed the widget. Call exactly one show_* tool per \
            turn and do not combine with other tool calls. Use 'kind=password' to hide the \
            entered text (good for tokens)."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Unique widget id for this turn (e.g. 'nuts_token', 'project_path')" },
                "prompt": { "type": "string", "description": "Short user-facing prompt above the input" },
                "kind": { "type": "string", "enum": ["text", "password", "number"], "description": "Input kind (default text)" },
                "default": { "type": "string", "description": "Optional default value" }
            },
            "required": ["id", "prompt"]
        }),
    }
}

fn show_button_def() -> ToolDef {
    ToolDef {
        name: "show_button".into(),
        description: "Render a clickable button inline in the chat and BLOCK until the user \
            clicks (or dismisses). The tool result is { ui_response: { id, value: 'clicked' } } \
            on click, or { ui_response: { id, dismissed: true } } if they ignored it. Use this \
            when you want a one-tap confirmation or to surface an action like 'Open config \
            editor'. Call exactly one show_* tool per turn."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Unique widget id for this turn" },
                "label": { "type": "string", "description": "Button text" },
                "hint": { "type": "string", "description": "Optional secondary text shown under the button" }
            },
            "required": ["id", "label"]
        }),
    }
}

fn show_picker_def() -> ToolDef {
    ToolDef {
        name: "show_picker".into(),
        description: "Render a single-select picker inline in the chat and BLOCK until the \
            user picks an option (or dismisses). The tool result is { ui_response: { id, value: \
            <chosen value> } } or { ui_response: { id, dismissed: true } }. Use this for model \
            selection, profile selection, yes/no with custom labels, etc. Call exactly one \
            show_* tool per turn."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Unique widget id for this turn" },
                "prompt": { "type": "string", "description": "Short user-facing prompt above the picker" },
                "options": {
                    "type": "array",
                    "description": "Options to choose from",
                    "items": {
                        "type": "object",
                        "properties": {
                            "value": { "type": "string", "description": "Returned as ui_response.value when picked" },
                            "label": { "type": "string", "description": "Display label" },
                            "description": { "type": "string", "description": "Optional secondary line under the label" }
                        },
                        "required": ["value", "label"]
                    }
                }
            },
            "required": ["id", "prompt", "options"]
        }),
    }
}

fn memory_embody_def() -> ToolDef {
    ToolDef {
        name: "memory_embody".into(),
        description: "Get a contextual self-snapshot from Ferricula: identity (agent_id, name, \
            archetype, hexagram), runtime status (memory counts, cognitive heat, thermodynamic \
            state), and the latest dream report. Use this at the start of a session for grounding \
            or before a complex task to orient yourself."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {}
        }),
    }
}

fn maximus_explain_def() -> ToolDef {
    ToolDef {
        name: "maximus_explain".into(),
        description: "Show what Maximus (tokenmax) did on the last tool extraction — content type \
            detected, strategy used, compression ratio, iteration count, and source \
            (Ollama / learned pattern / passthrough). Call this if a result looks wrong, \
            seems over-compressed, or you want to understand what was filtered out."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {}
        }),
    }
}

fn builtin_tool_defs() -> Vec<ToolDef> {
    let defs: Vec<serde_json::Value> = serde_json::from_value(serde_json::json!([
        {
            "name": "terminal_keys",
            "description": "Type keystrokes into a terminal pane. Use \\n for Enter, \\t for Tab.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "keys": { "type": "string", "description": "Keystrokes to type (e.g. \"ls -la\\n\")" },
                    "window": { "type": "integer", "description": "Window id (optional)" },
                    "tab": { "type": "string", "description": "Tab name (optional)" },
                    "pane": { "type": "string", "description": "Pane identifier from terminal_status: use the pane label when present, otherwise use paneId (optional)" }
                },
                "required": ["keys"]
            }
        },
        {
            "name": "terminal_run",
            "description": "Type text into a terminal pane and press Enter. Works for shell commands and interactive programs (Codex, Python REPL, vim, etc.). Set submit=false to type without pressing Enter — useful to let the human review before submitting. Pass focus= to receive only the relevant part of the output (e.g. \"exit code\", \"error messages\", \"port number\") — Maximus filters the result so you only see what you asked for.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Text or command to type" },
                    "submit": { "type": "boolean", "description": "Press Enter after typing (default true). Set false to type without submitting." },
                    "wait_ms": { "type": "integer", "description": "Time to wait for output in ms (default 2000)" },
                    "focus": { "type": "string", "description": "What you're looking for in the output (e.g. 'port number', 'error messages', 'did it succeed'). Maximus extracts just that — saves tokens." },
                    "raw": { "type": "boolean", "description": "Pass true to bypass Maximus and receive the full unfiltered output." },
                    "window": { "type": "integer" },
                    "tab": { "type": "string" },
                    "pane": { "type": "string" }
                },
                "required": ["command"]
            }
        },
        {
            "name": "terminal_split",
            "description": "Split a pane. Pass a label (e.g. 'b') to split that specific pane; omit label to split the currently focused pane.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["horizontal", "vertical"] },
                    "label": { "type": "string", "description": "Pane identifier from terminal_status. Use the pane label when present, otherwise use paneId. Focuses that pane before splitting." }
                },
                "required": ["direction"]
            }
        },
        {
            "name": "terminal_focus",
            "description": "Direct the human's attention to a pane — use this only when you want the human to look at a specific pane. Do NOT use this as a routing step before terminal_keys, terminal_run, or terminal_split; those tools address panes directly without needing a focus change.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "window": { "type": "integer" },
                    "tab": { "type": "string" },
                    "pane": { "type": "string" }
                }
            }
        },
        {
            "name": "terminal_rename",
            "description": "Rename a tab.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "New tab name" },
                    "window": { "type": "integer" },
                    "tab": { "type": "string" }
                },
                "required": ["name"]
            }
        },
        {
            "name": "terminal_where_pane",
            "description": "Describe the spatial relationship between two panes — e.g. 'pane b is below and to the right of pane a'. Pass pane identifiers from terminal_status. Use pane labels when present; otherwise use paneId.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "a": { "type": "string", "description": "Label of the reference pane (e.g. 'a')" },
                    "b": { "type": "string", "description": "Label of the pane to locate relative to a (e.g. 'b')" }
                },
                "required": ["a", "b"]
            }
        },
        {
            "name": "terminal_new_window",
            "description": "Open a new Hyperia window (separate OS window). Use terminal_status after to get its window id for targeting. Use this when the user wants a separate window, not just a new tab.",
            "input_schema": { "type": "object", "properties": {} }
        },
        {
            "name": "terminal_new_tab",
            "description": "Open a new tab. Use 'profile' to start a specific shell (e.g. 'WSL', 'PowerShell', 'Command Prompt') — get the exact name from terminal_status profiles[]. Omit profile to use the default shell. 'command' types a startup command into the new shell after it opens.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "profile": { "type": "string", "description": "Shell profile name from terminal_status profiles[] (e.g. 'WSL', 'Command Prompt'). Use this to open a specific shell." },
                    "command": { "type": "string", "description": "Command to run after the shell opens" }
                }
            }
        },
        {
            "name": "terminal_close",
            "description": "Close a pane/tab. Always call terminal_status first to get the uid of the tab you want to close, then pass that uid. Without a uid it closes whatever is currently focused — which is often the wrong tab.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "uid": { "type": "string", "description": "Session uid from terminal_status — identifies exactly which tab to close" }
                }
            }
        },
        {
            "name": "terminal_status",
            "description": "Get the current state of all windows, tabs, and panes.",
            "input_schema": { "type": "object", "properties": {} }
        },
        {
            "name": "terminal_screen",
            "description": "Read the current screen content of a pane as text. Pass focus= to receive only the relevant part (e.g. \"last error\", \"current directory\", \"running process name\") — Maximus filters the output so you only see what you asked for.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "focus": { "type": "string", "description": "What you're looking for on the screen (e.g. 'error messages', 'port number', 'git branch'). Maximus extracts just that — saves tokens." },
                    "raw": { "type": "boolean", "description": "Pass true to bypass Maximus and receive the full unfiltered output." },
                    "window": { "type": "integer" },
                    "tab": { "type": "string" },
                    "pane": { "type": "string" }
                }
            }
        },
        {
            "name": "file_read",
            "description": "Read a file from disk. Pass focus= to extract only the relevant section (e.g. \"the database config block\", \"function named foo\") — Maximus filters so you only see what you asked for.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path to read" },
                    "max_lines": { "type": "integer", "description": "Max lines (default 200)" },
                    "focus": { "type": "string", "description": "What you're looking for in the file (e.g. 'database URL', 'function named foo', 'port config'). Maximus extracts just that — saves tokens." },
                    "raw": { "type": "boolean", "description": "Pass true to bypass Maximus and receive the full unfiltered output." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "file_write",
            "description": "Write content to a file.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" },
                    "append": { "type": "boolean", "description": "Append instead of overwrite" }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": "sticky_note_create",
            "description": "Create a sticky note. The note appears as a floating window. Optionally specify position and size.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Note content" },
                    "x": { "type": "integer", "description": "X position (optional)" },
                    "y": { "type": "integer", "description": "Y position (optional)" },
                    "width": { "type": "integer", "description": "Width in pixels (optional)" },
                    "height": { "type": "integer", "description": "Height in pixels (optional)" }
                },
                "required": ["text"]
            }
        },
        {
            "name": "sticky_note_create_code",
            "description": "Open a source file as a code-highlighted sticky note. The note reads directly from disk — it is a window into the file, not a copy. IMPORTANT: You MUST provide a verified absolute path. Do NOT guess paths — use terminal_run (e.g. 'pwd' or 'ls') or file_read to confirm the exact path before calling this tool. The sidecar will reject the call with an error if the file does not exist.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "Absolute path to the source file on disk" },
                    "theme": { "type": "string", "enum": ["dark", "light"], "description": "dark (default) or light code theme" },
                    "x": { "type": "integer", "description": "X position (optional)" },
                    "y": { "type": "integer", "description": "Y position (optional)" },
                    "width": { "type": "integer", "description": "Width in pixels (default 500)" },
                    "height": { "type": "integer", "description": "Height in pixels (default 400)" }
                },
                "required": ["file_path"]
            }
        },
        {
            "name": "sticky_note_list",
            "description": "List all sticky notes. Returns their ids, text content, and position.",
            "input_schema": { "type": "object", "properties": {} }
        },
        {
            "name": "sticky_note_close",
            "description": "Close (hide) a sticky note by id. Does not delete it.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id from note_list" }
                },
                "required": ["id"]
            }
        },
        {
            "name": "sticky_note_update",
            "description": "Update the text of an existing sticky note.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id from note_list" },
                    "text": { "type": "string", "description": "New note content" }
                },
                "required": ["id", "text"]
            }
        },
        {
            "name": "sticky_note_delete",
            "description": "Permanently delete a sticky note by id.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id from note_list" }
                },
                "required": ["id"]
            }
        },
        {
            "name": "web_fetch",
            "description": "Fetch content from a URL.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "method": { "type": "string", "enum": ["GET", "POST", "PUT", "DELETE"] },
                    "body": { "type": "string" },
                    "headers": { "type": "object" }
                },
                "required": ["url"]
            }
        },
        {
            "name": "session_report",
            "description": "Save the current session's full tool call log to a file for analysis. Captures all tool calls, inputs, outputs, and text responses from this run. Saves to ~/.hyperia/reports/ by default. Use this when something went wrong, to capture a bug report, or to save a record of complex work.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "note": { "type": "string", "description": "Optional note to include at the top of the report (e.g. 'agent looped on terminal_screen', 'new feature test')" },
                    "path": { "type": "string", "description": "Override output file path. Defaults to ~/.hyperia/reports/YYYY-MM-DD-HH-MM.json" }
                }
            }
        },
        {
            "name": "tab_snapshot",
            "description": "Get the full screen content of every pane across all windows and tabs in one shot. Use this to see everything at once instead of calling terminal_screen per pane. Pass focus= to extract only what you care about across all panes (e.g. \"any running servers\", \"errors or failures\") — Maximus filters the dump so you only see what you asked for.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "focus": { "type": "string", "description": "What you're looking for across all panes (e.g. 'running servers', 'error messages', 'active processes'). Maximus extracts just that from the full dump — saves tokens." },
                    "raw": { "type": "boolean", "description": "Pass true to bypass Maximus and receive the full unfiltered output." }
                }
            }
        },
        {
            "name": "shell_state",
            "description": "Check the state of all panes (idle, running, dialog). Returns window/tab/pane for each.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "focus": { "type": "string", "description": "What you're looking for (e.g. 'panes that are still running', 'which tab has a dialog'). Maximus extracts just that — saves tokens." },
                    "raw": { "type": "boolean", "description": "Pass true to bypass Maximus and receive the full unfiltered output." }
                }
            }
        },
        {
            "name": "shell_confirm",
            "description": "Auto-handle common shell prompts — y/n, trust dialogs, continue prompts. Target a specific pane with window/tab/pane, or omit to scan the active pane.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "window": { "type": "integer" },
                    "tab": { "type": "string" },
                    "pane": { "type": "string" }
                }
            }
        },
        {
            "name": "terminal_ui_key",
            "description": "Send a UI-level keypress (e.g. Escape, Tab, arrow keys) to the Hyperia window — not to the terminal PTY. Use for navigating Hyperia's own UI.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "key_code": { "type": "string", "description": "Key code e.g. 'Escape', 'Tab', 'ArrowUp'" },
                    "modifiers": { "type": "array", "items": { "type": "string" }, "description": "Modifier keys e.g. ['ctrl'], ['shift']" },
                    "window": { "type": "integer" },
                    "tab": { "type": "string" },
                    "pane": { "type": "string" }
                },
                "required": ["key_code"]
            }
        },
        {
            "name": "auto_describe",
            "description": "Auto-describe a pane's content using local ollama. Generates a short description and stores it on the tab.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "window": { "type": "integer" },
                    "tab": { "type": "string" },
                    "pane": { "type": "string" }
                }
            }
        },
        {
            "name": "open_web_pane",
            "description": "Open a URL in a new web pane tab. Opens a dedicated browser tab inside Hyperia showing the given URL. Use this to show documentation, dashboards, search results, or any web content. Example: open_web_pane with url='https://google.com'",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Full URL to open (https://...)" }
                },
                "required": ["url"]
            }
        },
        {
            "name": "open_settings",
            "description": "Open the Hyperia Settings window. Use this when the user needs to configure their API token, change the agent model, set the Shivvr endpoint, or adjust other Hyperia settings.",
            "input_schema": {
                "type": "object",
                "properties": {}
            }
        }
    ]))
    .unwrap();

    defs.into_iter()
        .map(|v| serde_json::from_value(v).unwrap())
        .collect()
}

fn doctor_def() -> ToolDef {
    ToolDef {
        name: "doctor".into(),
        description: "Run a readiness probe across Hyperia's prerequisites and return a \
            structured JSON report. Checks: nuts.services token configured + best-effort auth \
            verification; nemesis8 binary on disk; shivvr embedding service reachability; \
            ferricula memory reachability + memory count; ollama running + installed models; \
            host platform + arch. Call this at the start of a configuration conversation to \
            decide what to ask the user next."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {}
        }),
    }
}

/// Probe Hyperia's prerequisites and return a JSON report. Each sub-probe
/// has its own tight timeout; the function returns when the slowest probe
/// finishes (or its timeout fires).
pub async fn run_doctor() -> serde_json::Value {
    let (nuts, nemesis, shivvr, ferricula, ollama) = tokio::join!(
        probe_nuts_token(),
        probe_nemesis(),
        probe_shivvr(),
        probe_ferricula(),
        probe_ollama(),
    );
    serde_json::json!({
        "nuts_token": nuts,
        "nemesis": nemesis,
        "shivvr": shivvr,
        "ferricula": ferricula,
        "ollama": ollama,
        "platform": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
    })
}

fn hyperia_config_path() -> std::path::PathBuf {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap_or_default()
    } else {
        std::env::var("HOME").unwrap_or_default()
    };
    std::path::PathBuf::from(home).join(".hyperia").join("hyperia.json")
}

fn read_hyperia_config() -> Option<serde_json::Value> {
    let path = hyperia_config_path();
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

async fn probe_nuts_token() -> serde_json::Value {
    let cfg = read_hyperia_config();
    let token = cfg
        .as_ref()
        .and_then(|c| c["config"]["nuts"]["token"].as_str())
        .map(|s| s.to_string());
    let configured = token.as_ref().map(|t| !t.is_empty()).unwrap_or(false);
    if !configured {
        return serde_json::json!({ "configured": false, "authenticated": false });
    }
    // Best-effort auth check. Endpoint may not exist yet; treat any network
    // failure as "unknown" rather than "unauthenticated".
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    let token_str = token.unwrap_or_default();
    let resp = client
        .get("https://api.nuts.services/auth/verify")
        .bearer_auth(&token_str)
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or(serde_json::Value::Null);
            serde_json::json!({
                "configured": true,
                "authenticated": true,
                "email": body["email"].as_str(),
            })
        }
        Ok(_) => serde_json::json!({ "configured": true, "authenticated": false }),
        Err(_) => serde_json::json!({
            "configured": true,
            "authenticated": null,
            "note": "auth endpoint unreachable — token may still be valid"
        }),
    }
}

async fn probe_nemesis() -> serde_json::Value {
    // Look for the binary in PATH and a few common install locations.
    let exe_name = if cfg!(windows) { "nemesis8.exe" } else { "nemesis8" };
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(home) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        candidates.push(std::path::PathBuf::from(&home).join(".nemesis8").join(exe_name));
        candidates.push(std::path::PathBuf::from(&home).join("bin").join(exe_name));
    }
    if cfg!(windows) {
        candidates.push(std::path::PathBuf::from("C:\\Program Files\\Nemesis8").join(exe_name));
    } else {
        candidates.push(std::path::PathBuf::from("/usr/local/bin").join(exe_name));
        candidates.push(std::path::PathBuf::from("/opt/homebrew/bin").join(exe_name));
    }
    // PATH lookup
    if let Ok(path_env) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path_env.split(sep) {
            candidates.push(std::path::PathBuf::from(dir).join(exe_name));
        }
    }
    for p in &candidates {
        if p.exists() {
            return serde_json::json!({
                "installed": true,
                "path": p.to_string_lossy(),
            });
        }
    }
    serde_json::json!({ "installed": false })
}

async fn probe_shivvr() -> serde_json::Value {
    // URL resolution: SHIVVR_URL env > hyperia.json config.shivvr.url > default.
    let url = std::env::var("SHIVVR_URL").ok()
        .or_else(|| {
            read_hyperia_config()
                .and_then(|c| c["config"]["shivvr"]["url"].as_str().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| "https://shivvr.nuts.services".to_string());
    let local = url.contains("localhost") || url.contains("127.0.0.1");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    let reachable = client
        .get(format!("{}/health", url.trim_end_matches('/')))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    serde_json::json!({
        "reachable": reachable,
        "url": url,
        "local": local,
    })
}

async fn probe_ferricula() -> serde_json::Value {
    let url = std::env::var("FERRICULA_URL").ok()
        .or_else(|| {
            read_hyperia_config()
                .and_then(|c| c["config"]["ferricula"]["url"].as_str().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| "http://localhost:8765".to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    let status_resp = client.get(format!("{}/status", url.trim_end_matches('/'))).send().await;
    let (reachable, memory_count) = match status_resp {
        Ok(r) if r.status().is_success() => {
            let text = r.text().await.unwrap_or_default();
            // Status is typically a formatted string with "rows=N"; extract.
            let count = text
                .lines()
                .find_map(|l| l.trim().strip_prefix("rows="))
                .and_then(|s| s.split_whitespace().next())
                .and_then(|s| s.parse::<u64>().ok());
            (true, count)
        }
        _ => (false, None),
    };
    serde_json::json!({
        "reachable": reachable,
        "url": url,
        "memory_count": memory_count,
    })
}

// -- Model catalog ----------------------------------------------------------

struct ModelEntry {
    id: &'static str,
    name: &'static str,
    provider: &'static str,
    context: u32,
    tier: &'static str,
    note: &'static str,
}

// Curated table of models the agent can pick. Add/edit entries here when
// providers ship new models. The agent uses this to drive a two-step
// show_picker flow: pick provider → pick model.
const MODEL_CATALOG: &[ModelEntry] = &[
    // Anthropic
    ModelEntry { id: "claude-opus-4-7",         name: "Claude Opus 4.7",        provider: "anthropic", context: 200_000, tier: "frontier", note: "Newest Opus — best reasoning, deepest tool use" },
    ModelEntry { id: "claude-sonnet-4-6",       name: "Claude Sonnet 4.6",      provider: "anthropic", context: 200_000, tier: "balanced", note: "Strong daily driver — fast and capable" },
    ModelEntry { id: "claude-haiku-4-5",        name: "Claude Haiku 4.5",       provider: "anthropic", context: 200_000, tier: "fast",     note: "Cheapest + fastest Claude — good for routine work" },
    ModelEntry { id: "claude-3-7-sonnet",       name: "Claude 3.7 Sonnet",      provider: "anthropic", context: 200_000, tier: "balanced", note: "Previous-gen Sonnet — still capable" },
    // OpenAI
    ModelEntry { id: "gpt-4.1",                 name: "GPT-4.1",                provider: "openai",    context: 1_000_000, tier: "frontier", note: "Long-context flagship" },
    ModelEntry { id: "gpt-4o",                  name: "GPT-4o",                 provider: "openai",    context: 128_000, tier: "balanced", note: "Multimodal default — vision + tools" },
    ModelEntry { id: "gpt-4o-mini",             name: "GPT-4o mini",            provider: "openai",    context: 128_000, tier: "fast",     note: "Cheap and quick" },
    ModelEntry { id: "o3-mini",                 name: "o3-mini",                provider: "openai",    context: 200_000, tier: "reasoning", note: "Smaller reasoning model" },
    ModelEntry { id: "o1",                      name: "o1",                     provider: "openai",    context: 200_000, tier: "reasoning", note: "Deep reasoning, no streaming" },
    // Local Ollama
    ModelEntry { id: "ollama:llama3.2",         name: "Llama 3.2",              provider: "ollama",    context: 128_000, tier: "local",    note: "General-purpose local model" },
    ModelEntry { id: "ollama:qwen2.5",          name: "Qwen 2.5",               provider: "ollama",    context: 128_000, tier: "local",    note: "Strong tool calling for a local model" },
    ModelEntry { id: "ollama:gemma4:e2b",       name: "Gemma 4 e2b",            provider: "ollama",    context: 8_192,   tier: "tiny",     note: "Maximus's compression model — small + fast" },
    ModelEntry { id: "ollama:mistral",          name: "Mistral 7B",             provider: "ollama",    context: 32_768,  tier: "local",    note: "Solid baseline local model" },
];

fn entry_to_json(e: &ModelEntry) -> serde_json::Value {
    serde_json::json!({
        "id": e.id,
        "name": e.name,
        "provider": e.provider,
        "context": e.context,
        "tier": e.tier,
        "note": e.note,
    })
}

fn model_catalog_def() -> ToolDef {
    ToolDef {
        name: "model_catalog".into(),
        description: "List available LLM providers and models. Pass no arguments to get the list of \
            providers (anthropic, openai, ollama, ...) for a first show_picker step. Pass \
            provider=\"<name>\" to list the models for that provider for a second show_picker. \
            Each model entry has id, name, provider, context window, tier, and a one-line note \
            describing what it's good for. Use this to drive 'change my model' flows."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "provider": { "type": "string", "description": "Filter to one provider's models. Omit to get the list of providers." },
                "query": { "type": "string", "description": "Optional fuzzy substring filter against id, name, or note." }
            }
        }),
    }
}

/// Returns either a provider list (when no provider given) or the models
/// for a specific provider. JSON shape:
///   { providers: [{provider, model_count}], default_provider: ... }
///   { models: [...], provider: "anthropic" }
fn model_catalog(input: &serde_json::Value) -> String {
    let provider = input["provider"].as_str().unwrap_or("").trim().to_lowercase();
    let query = input["query"].as_str().unwrap_or("").trim().to_lowercase();

    if provider.is_empty() {
        // Aggregate by provider
        let mut counts: std::collections::BTreeMap<&str, u32> =
            std::collections::BTreeMap::new();
        for e in MODEL_CATALOG.iter() {
            *counts.entry(e.provider).or_insert(0) += 1;
        }
        let providers: Vec<serde_json::Value> = counts
            .into_iter()
            .map(|(p, c)| {
                serde_json::json!({
                    "provider": p,
                    "model_count": c,
                    "label": match p {
                        "anthropic" => "Anthropic (Claude)",
                        "openai" => "OpenAI (GPT, o-series)",
                        "ollama" => "Ollama (local)",
                        other => other,
                    },
                })
            })
            .collect();
        return serde_json::json!({
            "providers": providers,
        })
        .to_string();
    }

    let models: Vec<serde_json::Value> = MODEL_CATALOG
        .iter()
        .filter(|e| e.provider.eq_ignore_ascii_case(&provider))
        .filter(|e| {
            if query.is_empty() {
                return true;
            }
            e.id.to_lowercase().contains(&query)
                || e.name.to_lowercase().contains(&query)
                || e.note.to_lowercase().contains(&query)
        })
        .map(entry_to_json)
        .collect();

    serde_json::json!({
        "provider": provider,
        "models": models,
    })
    .to_string()
}

async fn probe_ollama() -> serde_json::Value {
    let url = std::env::var("OLLAMA_HOST")
        .unwrap_or_else(|_| "http://localhost:11434".to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    let resp = client.get(format!("{}/api/tags", url.trim_end_matches('/'))).send().await;
    match resp {
        Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or(serde_json::Value::Null);
            let models: Vec<String> = body["models"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            serde_json::json!({
                "running": true,
                "url": url,
                "models": models,
            })
        }
        _ => serde_json::json!({ "running": false, "url": url, "models": [] }),
    }
}
