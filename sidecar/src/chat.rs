use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Incremental updates from the streaming API thread.
enum ChatChunk {
    Delta(String),
    Done,
    Error(String),
}

pub struct ChatState {
    pub messages: Vec<ChatMessage>,
    pub input: String,
    pub scroll: usize,
    pub loading: bool,
    chunk_rx: Option<mpsc::Receiver<ChatChunk>>,
    http_port: u16,
}

impl ChatState {
    pub fn new() -> Self {
        let http_port = 9090; // default, overridden by with_port
        Self {
            messages: Vec::new(),
            input: String::new(),
            scroll: 0,
            loading: false,
            chunk_rx: None,
            http_port,
        }
    }

    pub fn with_port(mut self, port: u16) -> Self {
        self.http_port = port;
        self
    }

    pub fn scroll_up(&mut self) {
        self.scroll = self.scroll.saturating_add(1);
    }

    pub fn scroll_down(&mut self) {
        self.scroll = self.scroll.saturating_sub(1);
    }

    /// Check if the input is a local command that doesn't need the API.
    /// Returns Some(response) if handled locally, None if it should go to API.
    fn handle_local_command(input: &str, http_port: u16) -> Option<String> {
        let trimmed = input.trim().to_lowercase();
        match trimmed.as_str() {
            "exit" | "quit" | "q" => {
                // Send quit command via raw HTTP
                let _ = std::thread::spawn(move || {
                    use std::io::Write as _;
                    if let Ok(mut stream) = std::net::TcpStream::connect(format!("127.0.0.1:{}", http_port)) {
                        let _ = write!(stream, "POST /api/quit HTTP/1.0\r\nHost: localhost\r\n\r\n");
                    }
                });
                Some("Shutting down...".to_string())
            }
            "help" => {
                Some("Chat commands:\n  exit/quit - quit terminal\n  help - this message\n\nKeyboard:\n  Ctrl+B q - quit\n  Ctrl+B z - zoom\n  Tab - cycle focus\n  Esc - close panel\n  ` - toggle panels".to_string())
            }
            _ => None,
        }
    }

    /// Send a message to the Anthropic streaming API with terminal context and tools.
    pub fn send_message(&mut self, screen_text: String, pane_name: String) {
        let user_text = self.input.clone();
        self.input.clear();
        self.scroll = 0;

        self.messages.push(ChatMessage {
            role: "user".to_string(),
            content: user_text.clone(),
        });

        // Check for local commands first
        if let Some(response) = Self::handle_local_command(&user_text, self.http_port) {
            self.messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: response,
            });
            return;
        }

        let api_key = std::env::var("ANTHROPIC_API_KEY").unwrap_or_default();
        if api_key.is_empty() {
            self.messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: "ANTHROPIC_API_KEY not set. Type 'help' for local commands, or Ctrl+B q to quit.".to_string(),
            });
            return;
        }

        self.loading = true;
        let (tx, rx) = mpsc::channel();
        self.chunk_rx = Some(rx);

        // Push a placeholder assistant message that we'll stream into
        self.messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: String::new(),
        });

        let history: Vec<ChatMessage> = self.messages.clone();
        let http_port = self.http_port;

        thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = tx.send(ChatChunk::Error(format!("Runtime error: {}", e)));
                    let _ = tx.send(ChatChunk::Done);
                    return;
                }
            };

            rt.block_on(agent_loop(
                &api_key, &history, &screen_text, &pane_name, http_port, &tx,
            ));
        });
    }

    /// Poll for streaming chunks. Returns true if any new data arrived.
    pub fn check_response(&mut self) -> bool {
        let mut got_data = false;
        if let Some(ref rx) = self.chunk_rx {
            loop {
                match rx.try_recv() {
                    Ok(ChatChunk::Delta(text)) => {
                        if let Some(last) = self.messages.last_mut() {
                            last.content.push_str(&text);
                        }
                        got_data = true;
                    }
                    Ok(ChatChunk::Done) => {
                        self.loading = false;
                        self.chunk_rx = None;
                        got_data = true;
                        break;
                    }
                    Ok(ChatChunk::Error(e)) => {
                        if let Some(last) = self.messages.last_mut() {
                            last.content.push_str(&format!("\n[Error: {}]", e));
                        }
                        self.loading = false;
                        self.chunk_rx = None;
                        got_data = true;
                        break;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        self.loading = false;
                        self.chunk_rx = None;
                        break;
                    }
                }
            }
        }
        got_data
    }
}

// ---------------------------------------------------------------------------
// DIYClaw Prompt Pack Loader
// ---------------------------------------------------------------------------

/// Load a prompt pack file from the diyclaw-prompt-pack directory.
/// Falls back to empty string if file not found (graceful degradation).
fn load_pack_file(filename: &str) -> String {
    // Try relative to executable first, then current dir, then hardcoded dev path
    let candidates = [
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("diyclaw-prompt-pack").join(filename))),
        Some(std::path::PathBuf::from(format!("diyclaw-prompt-pack/{}", filename))),
        Some(std::path::PathBuf::from(format!(
            "C:/Users/kord/Code/gnosis/hyperia/diyclaw-prompt-pack/{}",
            filename
        ))),
    ];

    for candidate in candidates.iter().flatten() {
        if let Ok(content) = std::fs::read_to_string(candidate) {
            return content;
        }
    }

    String::new()
}

/// Compile the system prompt from the DIYClaw prompt pack.
/// P = f(S, E, T, C) — base system + execution + environment + security + failure + agent role + context
fn compile_system_prompt(screen_text: &str, pane_name: &str) -> String {
    let base = load_pack_file("base_system.txt");
    let execution = load_pack_file("execution.txt");
    let environment = load_pack_file("environment.txt");
    let security = load_pack_file("security.txt");
    let failure = load_pack_file("failure.txt");

    // Load Gonff as default agent role (primary terminal operator)
    let agent_role = load_pack_file("agents/gonff.txt");

    // Strip slot markers — fill with runtime values
    let execution = execution
        .replace("{{SLOT:max_steps:Hard limit on total turns (default: 25)}}", "15")
        .replace("{{SLOT:wall_time_ms:Max wall time in milliseconds (default: 120000)}}", "120000")
        .replace("{{SLOT:token_budget:Max cumulative input + output tokens (default: 50000)}}", "50000")
        .replace("{{SLOT:tool_call_budget:Max tool invocations this run (default: 50)}}", "30")
        .replace("{{SLOT:output_validation:Validation approach — baml (recommended, type-safe structured outputs via boundaryml.com) | json_schema | zod | none}}", "none")
        .replace("{{SLOT:log_sink:Where errors surface — console, file path, HTTP endpoint, or channel name}}", "console")
        .replace("{{SLOT:diagnostics_endpoint:Optional health/status endpoint path e.g. /healthz}}", "/health");

    let environment = environment
        .replace("{{SLOT:provider:LLM provider — openai | anthropic | ollama | custom}}", "anthropic")
        .replace("{{SLOT:model_id:Model identifier e.g. claude-sonnet-4-20250514}}", "claude-sonnet-4-20250514")
        .replace("{{SLOT:api_version:Provider API version string}}", "2023-06-01")
        .replace("{{SLOT:env_max_steps:Default 25}}", "15")
        .replace("{{SLOT:env_wall_time:Default 120000}}", "120000")
        .replace("{{SLOT:env_max_tokens:Default 50000}}", "50000")
        .replace("{{SLOT:env_max_tool_calls:Default 50}}", "30")
        .replace("{{SLOT:env_max_per_turn:Default 5}}", "5")
        .replace("{{SLOT:policy_mode:Runtime mode — chat | builder | operator}}", "operator")
        .replace("{{SLOT:allowed_tools:Explicit tool allowlist as JSON array}}", "[\"terminal_keys\",\"terminal_split\",\"terminal_focus\",\"terminal_rename\",\"terminal_new_tab\",\"terminal_close\",\"terminal_status\",\"terminal_screen\",\"terminal_quit\",\"console_open\",\"console_close\",\"console_logs\",\"file_read\",\"file_write\",\"web_fetch\"]")
        .replace("{{SLOT:denied_tools:Explicit tool denylist — overrides allowlist}}", "[]")
        .replace("{{SLOT:workspace_scope:Filesystem path or container ID for this agent}}", "terminal")
        .replace("{{SLOT:project_id:Project identifier}}", "gnosis-terminal")
        .replace("{{SLOT:persistent_storage:true | false — ephemeral by default}}", "false")
        .replace("{{SLOT:debug:true | false — verbose logging when true}}", "false")
        .replace("{{SLOT:validation_runtime:BAML (boundaryml.com) for type-safe LLM calls, or none for raw JSON}}", "none")
        .replace("{{SLOT:baml_schema_path:Path to .baml function definitions, e.g. ./baml_src/ — leave empty if not using BAML}}", "")
        .replace("{{SLOT:config_path:Config file location e.g. ~/.gnosis/config.toml}}", "~/.gnosis/config.toml")
        .replace("{{SLOT:secret_store:Secret backend — env | vault | aws_ssm}}", "env");

    let security = security
        .replace("{{SLOT:security_log:Where injection attempts are logged — same as log_sink or a dedicated security channel}}", "console")
        .replace("{{SLOT:workspace_boundary:Filesystem path or container scope this agent may access}}", "terminal panes")
        .replace("{{SLOT:allowed_hosts:List of hosts the agent may contact, or * for unrestricted}}", "localhost");

    let failure = failure
        .replace("{{SLOT:backoff_base:Base backoff seconds, default 1}}", "1")
        .replace("{{SLOT:backoff_max:Max backoff seconds, default 30}}", "30")
        .replace("{{SLOT:retry_max:Max retry attempts per tool call, default 3}}", "3")
        .replace("{{SLOT:failover_list:Ordered list of failover providers, or empty if single-provider}}", "")
        .replace("{{SLOT:failure_log_sink:Where failure logs go — same as execution log_sink, or separate}}", "console");

    // Strip remaining SLOT_NOT markers (constraints that apply at runtime, not in prompt text)
    let strip_slot_not = |s: String| -> String {
        let mut result = String::new();
        for line in s.lines() {
            if !line.contains("{{SLOT_NOT:") && !line.contains("{{SLOT:") {
                result.push_str(line);
                result.push('\n');
            }
        }
        result
    };

    let base = strip_slot_not(base);
    let execution = strip_slot_not(execution);
    let environment = strip_slot_not(environment);
    let security = strip_slot_not(security);
    let failure = strip_slot_not(failure);
    let agent_role = strip_slot_not(agent_role);

    format!(
        "{base}\n\n{agent_role}\n\n{execution}\n\n{environment}\n\n{security}\n\n{failure}\n\n\
         [CONTEXT]\n\
         The user is looking at pane '{pane_name}'. Current screen:\n```\n{screen}\n```\n\n\
         When closing, focusing, or operating on panes, ALWAYS call terminal_status first \
         to get window/tab/pane identifiers. Use the pane label when present, otherwise use paneId. Tell the user WHICH pane you targeted.\n\
         Before installing software, modifying system settings, or running destructive commands, ASK the user first.\n\
         For simple read-only commands (ls, cat, echo, pip list, dir, pwd, git status), execute directly.\n\
         When showing command results, briefly describe what you see. Be concise. Act first, explain after.\n\
         You can read and write files directly with file_read/file_write — use these for viewing source, \
         editing configs, or saving scripts. Use web_fetch to call APIs or check URLs.\n\n\
         ## Agent Execution Rules:\n\
         1. STRUCTURED WORKFLOWS:\n\
            - Web Content: open_web_pane -> terminal_status -> Parse tabId -> web_pane_content.\n\
            - Terminal Execution: terminal_status -> Parse active paneId -> terminal_run -> terminal_screen.\n\
         2. TARGET PARAMETERS:\n\
            - Terminal tools (terminal_screen, terminal_run) target a 'pane' (e.g. split labels \"a\", \"b\" or paneId UUIDs).\n\
            - Web tools (web_pane_content, web_pane_eval) target a 'tab' (e.g. tabId UUID or tab name).\n\
            - For simple tasks in the current view, omit target parameters (window, tab, pane) to leverage target defaults.\n\
         3. PAGE LOAD ASYNCHRONY: When open_web_pane returns, wait briefly or verify that the content is loaded before summarizing.",
        base = base.trim(),
        agent_role = agent_role.trim(),
        execution = execution.trim(),
        environment = environment.trim(),
        security = security.trim(),
        failure = failure.trim(),
        pane_name = pane_name,
        screen = &screen_text.chars().take(3000).collect::<String>(),
    )
}

// ---------------------------------------------------------------------------
// Tool Definitions & Execution
// ---------------------------------------------------------------------------

/// Tool definitions for the Anthropic API.
fn tool_definitions() -> Vec<serde_json::Value> {
    serde_json::json!([
        {
            "name": "terminal_keys",
            "description": "Type keystrokes into a terminal pane. Use \\n for Enter, \\t for Tab. Can run commands by typing them and pressing Enter.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "keys": { "type": "string", "description": "Keystrokes to type (e.g. \"ls -la\\n\")" },
                    "window": { "type": "integer", "description": "Window id from terminal_status (optional)" },
                    "tab": { "type": "string", "description": "Tab name from terminal_status (optional)" },
                    "pane": { "type": "string", "description": "Pane label within the tab, e.g. \"a\" or \"b\" (optional)" }
                },
                "required": ["keys"]
            }
        },
        {
            "name": "terminal_split",
            "description": "Split the focused pane into two panes.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["horizontal", "vertical"], "description": "Split direction" }
                },
                "required": ["direction"]
            }
        },
        {
            "name": "terminal_focus",
            "description": "Change which pane has focus.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "window": { "type": "integer", "description": "Window id from terminal_status (optional)" },
                    "tab": { "type": "string", "description": "Tab name from terminal_status (optional)" },
                    "pane": { "type": "string", "description": "Pane label within the tab, e.g. \"a\" or \"b\"" }
                }
            }
        },
        {
            "name": "terminal_rename",
            "description": "Rename a tab by window/tab address, or rename the active tab if omitted.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "New tab name" },
                    "window": { "type": "integer", "description": "Window id from terminal_status (optional)" },
                    "tab": { "type": "string", "description": "Current tab name from terminal_status (optional)" }
                },
                "required": ["name"]
            }
        },
        {
            "name": "terminal_new_tab",
            "description": "Open a new tab. Optionally run a startup command in it.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to run after the tab opens" }
                }
            }
        },
        {
            "name": "terminal_close",
            "description": "Close the focused pane. Always check terminal_status first to know window/tab/pane identifiers. Use the pane label when present, otherwise use paneId.",
            "input_schema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "terminal_status",
            "description": "Get the current state of all panes (IDs, names, which is focused, bell state).",
            "input_schema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "terminal_screen",
            "description": "Read the current screen content of a pane as text.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "window": { "type": "integer", "description": "Window id from terminal_status (optional)" },
                    "tab": { "type": "string", "description": "Tab name from terminal_status (optional)" },
                    "pane": { "type": "string", "description": "Pane label within the tab, e.g. \"a\" or \"b\" (optional)" }
                }
            }
        },
        {
            "name": "terminal_quit",
            "description": "Quit the entire terminal application. Only use when the user explicitly asks to exit.",
            "input_schema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "console_open",
            "description": "Open the chat + logs panels.",
            "input_schema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "console_close",
            "description": "Close the chat + logs panels.",
            "input_schema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "console_logs",
            "description": "Read the terminal's log output. Returns recent log lines including HTTP requests from other agents.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "lines": { "type": "integer", "description": "Number of log lines to return (default: 100)" }
                }
            }
        },
        {
            "name": "file_read",
            "description": "Read a file from disk. Returns the file contents as text. Use for viewing source code, configs, logs, etc.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute or relative file path to read" },
                    "max_lines": { "type": "integer", "description": "Max lines to return (default: 200, max: 1000)" }
                },
                "required": ["path"]
            }
        },
        {
            "name": "file_write",
            "description": "Write content to a file. Creates parent directories if needed. Use for saving scripts, configs, notes.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute or relative file path to write" },
                    "content": { "type": "string", "description": "Content to write to the file" },
                    "append": { "type": "boolean", "description": "If true, append instead of overwrite (default: false)" }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": "web_fetch",
            "description": "Fetch content from a URL. Returns the response body as text. Useful for checking APIs, downloading data, or reading web pages.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "URL to fetch" },
                    "method": { "type": "string", "enum": ["GET", "POST", "PUT", "DELETE"], "description": "HTTP method (default: GET)" },
                    "body": { "type": "string", "description": "Request body (for POST/PUT)" },
                    "headers": { "type": "object", "description": "Additional HTTP headers as key-value pairs" }
                },
                "required": ["url"]
            }
        }
    ])
    .as_array()
    .unwrap()
    .clone()
}

/// Execute a tool call against the terminal HTTP API.
async fn execute_tool(
    name: &str,
    input: &serde_json::Value,
    http_port: u16,
) -> String {
    let base = format!("http://localhost:{}", http_port);
    let client = reqwest::Client::new();
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

    let result = match name {
        "terminal_keys" => {
            let keys = input["keys"].as_str().unwrap_or("");
            // Unescape common sequences
            let keys = keys.replace("\\n", "\r").replace("\\t", "\t");
            client.post(build_target_url("/api/type")).body(keys).send().await
        }
        "terminal_split" => {
            let dir = input["direction"].as_str().unwrap_or("vertical");
            let body = serde_json::json!({ "direction": dir });
            client.post(format!("{}/api/pane/split", base)).json(&body).send().await
        }
        "terminal_focus" => {
            let body = serde_json::json!({
                "window": input["window"],
                "tab": input["tab"],
                "pane": input["pane"],
            });
            client.post(format!("{}/api/pane/focus", base)).json(&body).send().await
        }
        "terminal_rename" => {
            let name = input["name"].as_str().unwrap_or("unnamed");
            let body = serde_json::json!({
                "name": name,
                "window": input["window"],
                "tab": input["tab"],
            });
            client.post(format!("{}/api/pane/rename", base)).json(&body).send().await
        }
        "terminal_new_tab" => {
            let body = serde_json::json!({
                "command": input["command"],
            });
            client.post(format!("{}/api/pane/new", base)).json(&body).send().await
        }
        "terminal_close" => {
            let body = serde_json::json!({});
            client.post(format!("{}/api/pane/close", base)).json(&body).send().await
        }
        "terminal_status" => {
            client.get(format!("{}/api/status", base)).send().await
        }
        "terminal_screen" => {
            // Fetch screen and extract just text lines (attrs are huge)
            match client.get(build_target_url("/api/screen")).send().await {
                Ok(resp) => {
                    let text = resp.text().await.unwrap_or_default();
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        let lines: Vec<&str> = json["lines"]
                            .as_array()
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|l| l["text"].as_str())
                                    .collect()
                            })
                            .unwrap_or_default();
                        return lines.join("\n");
                    }
                    return text;
                }
                Err(e) => return format!("HTTP error: {}", e),
            }
        }
        "terminal_quit" => {
            client.post(format!("{}/api/quit", base)).send().await
        }
        "console_open" => {
            client.post(format!("{}/api/console/open", base)).send().await
        }
        "console_close" => {
            client.post(format!("{}/api/console/close", base)).send().await
        }
        "console_logs" => {
            let lines = input["lines"].as_u64().unwrap_or(100);
            client.get(format!("{}/api/console/logs?lines={}", base, lines)).send().await
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

            // Create parent directories if needed
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
                std::fs::write(path, content).map(|_| ())
            };

            return match result {
                Ok(()) => format!("Wrote {} bytes to {}", content.len(), path),
                Err(e) => format!("Error writing file: {}", e),
            };
        }
        "web_fetch" => {
            let url = input["url"].as_str().unwrap_or("");
            let method = input["method"].as_str().unwrap_or("GET");

            let mut req = match method {
                "POST" => client.post(url),
                "PUT" => client.put(url),
                "DELETE" => client.delete(url),
                _ => client.get(url),
            };

            // Add custom headers
            if let Some(headers) = input["headers"].as_object() {
                for (k, v) in headers {
                    if let Some(val) = v.as_str() {
                        req = req.header(k.as_str(), val);
                    }
                }
            }

            // Add body for POST/PUT
            if let Some(body) = input["body"].as_str() {
                req = req.body(body.to_string());
            }

            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    // Truncate large responses
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
        _ => return format!("Unknown tool: {}", name),
    };

    match result {
        Ok(resp) => resp.text().await.unwrap_or_else(|e| format!("Read error: {}", e)),
        Err(e) => format!("HTTP error: {}", e),
    }
}

// ---------------------------------------------------------------------------
// Agent Loop with DIYClaw Execution Contract Enforcement
// ---------------------------------------------------------------------------

/// Agent loop: call API, execute tool uses, enforce execution contract budgets.
async fn agent_loop(
    api_key: &str,
    history: &[ChatMessage],
    screen_text: &str,
    pane_name: &str,
    http_port: u16,
    tx: &mpsc::Sender<ChatChunk>,
) {
    let system_prompt = compile_system_prompt(screen_text, pane_name);

    // Execution contract budgets (from execution.txt)
    let max_steps: usize = 15;
    let wall_time_budget_ms: u128 = 120_000;
    let tool_call_budget: usize = 30;
    let no_op_limit: usize = 3;

    let start_time = Instant::now();
    let mut total_tool_calls: usize = 0;
    let mut consecutive_no_ops: usize = 0;
    let mut last_tool_failures: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    // Build API messages — exclude empty placeholder
    let mut api_messages: Vec<serde_json::Value> = history
        .iter()
        .filter(|m| !(m.role == "assistant" && m.content.is_empty()))
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        })
        .collect();

    let tools = tool_definitions();
    let client = reqwest::Client::new();

    for _step in 0..max_steps {
        // Budget check: wall time
        let elapsed = start_time.elapsed().as_millis();
        if elapsed > wall_time_budget_ms {
            let _ = tx.send(ChatChunk::Delta(format!(
                "\n[Stopped: wall time budget exceeded ({:.1}s / {:.1}s)]",
                elapsed as f64 / 1000.0,
                wall_time_budget_ms as f64 / 1000.0
            )));
            break;
        }

        // Budget check: tool calls
        if total_tool_calls >= tool_call_budget {
            let _ = tx.send(ChatChunk::Delta(format!(
                "\n[Stopped: tool call budget exceeded ({}/{})]",
                total_tool_calls, tool_call_budget
            )));
            break;
        }

        // No-op detection
        if consecutive_no_ops >= no_op_limit {
            let _ = tx.send(ChatChunk::Delta(format!(
                "\n[Stopped: {} consecutive turns with no progress]",
                no_op_limit
            )));
            break;
        }

        let body = serde_json::json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1024,
            "system": system_prompt,
            "messages": api_messages,
            "tools": tools,
        });

        let response = match client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(ChatChunk::Error(format!("Request failed: {}", e)));
                let _ = tx.send(ChatChunk::Done);
                return;
            }
        };

        let status = response.status();
        let text = match response.text().await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(ChatChunk::Error(format!("Read error: {}", e)));
                let _ = tx.send(ChatChunk::Done);
                return;
            }
        };

        if !status.is_success() {
            let _ = tx.send(ChatChunk::Error(format!("API error ({}): {}", status, text)));
            let _ = tx.send(ChatChunk::Done);
            return;
        }

        let json: serde_json::Value = match serde_json::from_str(&text) {
            Ok(j) => j,
            Err(e) => {
                let _ = tx.send(ChatChunk::Error(format!("JSON error: {}", e)));
                let _ = tx.send(ChatChunk::Done);
                return;
            }
        };

        let content = json["content"].as_array().cloned().unwrap_or_default();

        // Process content blocks
        let mut has_tool_use = false;
        let mut tool_results: Vec<serde_json::Value> = Vec::new();
        let mut made_progress = false;

        for block in &content {
            let block_type = block["type"].as_str().unwrap_or("");
            match block_type {
                "text" => {
                    if let Some(t) = block["text"].as_str() {
                        if !t.is_empty() {
                            made_progress = true;
                        }
                        let _ = tx.send(ChatChunk::Delta(t.to_string()));
                    }
                }
                "tool_use" => {
                    has_tool_use = true;
                    made_progress = true;
                    let tool_name = block["name"].as_str().unwrap_or("");
                    let tool_id = block["id"].as_str().unwrap_or("");
                    let tool_input = &block["input"];

                    total_tool_calls += 1;

                    // Descriptive narration per tool
                    let narration = match tool_name {
                        "terminal_keys" => {
                            let keys = tool_input["keys"].as_str().unwrap_or("");
                            let display = keys.replace("\\n", "\u{23ce}").replace("\\t", "\u{21e5}");
                            let truncated = if display.len() > 60 {
                                format!("{}...", &display[..60])
                            } else {
                                display
                            };
                            format!("\n> Typing '{}' in focused pane\n", truncated)
                        }
                        "terminal_split" => {
                            let dir = tool_input["direction"].as_str().unwrap_or("vertical");
                            format!("\n> Splitting pane {}\n", dir)
                        }
                        "terminal_close" => {
                            if let Some(id) = tool_input["id"].as_u64() {
                                format!("\n> Closing pane {}\n", id)
                            } else {
                                "\n> Closing focused pane\n".to_string()
                            }
                        }
                        "terminal_screen" => "\n> Reading screen content\n".to_string(),
                        "terminal_status" => "\n> Checking pane layout\n".to_string(),
                        "terminal_focus" => "\n> Switching pane focus\n".to_string(),
                        "terminal_rename" => {
                            let name = tool_input["name"].as_str().unwrap_or("?");
                            format!("\n> Renaming pane to '{}'\n", name)
                        }
                        "terminal_quit" => "\n> Quitting terminal\n".to_string(),
                        "console_open" | "console_close" => "\n> Toggling console\n".to_string(),
                        "console_logs" => "\n> Reading logs\n".to_string(),
                        "file_read" => {
                            let path = tool_input["path"].as_str().unwrap_or("?");
                            format!("\n> Reading file '{}'\n", path)
                        }
                        "file_write" => {
                            let path = tool_input["path"].as_str().unwrap_or("?");
                            let append = tool_input["append"].as_bool().unwrap_or(false);
                            if append {
                                format!("\n> Appending to '{}'\n", path)
                            } else {
                                format!("\n> Writing file '{}'\n", path)
                            }
                        }
                        "web_fetch" => {
                            let url = tool_input["url"].as_str().unwrap_or("?");
                            let method = tool_input["method"].as_str().unwrap_or("GET");
                            format!("\n> {} {}\n", method, url)
                        }
                        _ => format!("\n> [{}]\n", tool_name),
                    };
                    let _ = tx.send(ChatChunk::Delta(narration));

                    // Execute the tool
                    let result = execute_tool(tool_name, tool_input, http_port).await;

                    // Track repeated failures (DIYClaw §4: same tool fails 3 times → stop)
                    let is_error = result.contains("HTTP error") || result.contains("error");
                    if is_error {
                        let count = last_tool_failures.entry(tool_name.to_string()).or_insert(0);
                        *count += 1;
                        if *count >= 3 {
                            let _ = tx.send(ChatChunk::Delta(format!(
                                "\n[Stopped: {} failed {} times consecutively]",
                                tool_name, count
                            )));
                            let _ = tx.send(ChatChunk::Done);
                            return;
                        }
                    } else {
                        last_tool_failures.remove(tool_name);
                    }

                    // Truncate tool results to avoid token overflow
                    let result = if result.len() > 4000 {
                        format!("{}...[truncated]", &result[..4000])
                    } else {
                        result
                    };

                    tool_results.push(serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": result,
                    }));
                }
                _ => {}
            }
        }

        // Track no-op turns
        if made_progress {
            consecutive_no_ops = 0;
        } else {
            consecutive_no_ops += 1;
        }

        if has_tool_use {
            // Add assistant response with tool_use blocks to history
            api_messages.push(serde_json::json!({
                "role": "assistant",
                "content": content,
            }));
            // Add tool results
            api_messages.push(serde_json::json!({
                "role": "user",
                "content": tool_results,
            }));
            // Continue the loop for the next API call
            continue;
        }

        // No tool use — we're done (end_turn or max_tokens)
        break;
    }

    let _ = tx.send(ChatChunk::Done);
}
