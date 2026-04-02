use std::sync::{Arc, Mutex};

use super::types::ToolDef;

/// A dynamically created tool backed by a shell command.
#[derive(Debug, Clone)]
pub struct DynamicTool {
    pub def: ToolDef,
    pub command_template: String,
}

pub struct ToolRegistry {
    builtins: Vec<ToolDef>,
    dynamic: Arc<Mutex<Vec<DynamicTool>>>,
    client: reqwest::Client,
    http_port: u16,
}

impl ToolRegistry {
    pub fn new(http_port: u16) -> Self {
        Self {
            builtins: builtin_tool_defs(),
            dynamic: Arc::new(Mutex::new(Vec::new())),
            client: reqwest::Client::new(),
            http_port,
        }
    }

    /// All tool definitions for sending to the Anthropic API.
    pub fn tool_defs(&self) -> Vec<ToolDef> {
        let mut defs = self.builtins.clone();
        defs.push(tool_search_def());
        defs.push(tool_create_def());
        let dynamic = self.dynamic.lock().unwrap();
        for dt in dynamic.iter() {
            defs.push(dt.def.clone());
        }
        defs
    }

    /// Execute a tool by name with the given input.
    pub async fn execute(&self, name: &str, input: &serde_json::Value) -> String {
        match name {
            "tool_search" => self.handle_tool_search(input),
            "tool_create" => self.handle_tool_create(input),
            _ if self.is_builtin(name) => self.execute_builtin(name, input).await,
            _ => self.execute_dynamic(name, input).await,
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
        let command = match input["command"].as_str() {
            Some(c) => c.to_string(),
            None => return "Error: 'command' is required".into(),
        };
        let parameters = input["parameters"].clone();
        let schema = if parameters.is_null() || parameters.is_object() && parameters.as_object().map_or(true, |o| o.is_empty()) {
            serde_json::json!({
                "type": "object",
                "properties": {},
            })
        } else {
            parameters
        };

        let tool = DynamicTool {
            def: ToolDef {
                name: name.clone(),
                description,
                input_schema: schema,
            },
            command_template: command,
        };

        let mut dynamic = self.dynamic.lock().unwrap();
        // Replace if same name exists
        dynamic.retain(|t| t.def.name != name);
        dynamic.push(tool);

        format!("Tool '{}' created successfully. You can now call it.", name)
    }

    async fn execute_dynamic(&self, name: &str, input: &serde_json::Value) -> String {
        let tool = {
            let dynamic = self.dynamic.lock().unwrap();
            match dynamic.iter().find(|t| t.def.name == name) {
                Some(t) => t.clone(),
                None => return format!("Unknown tool: {}", name),
            }
        };

        // Substitute {{input.fieldName}} in the command template
        let mut cmd = tool.command_template.clone();
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

        // Execute the command
        match tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
            .args(if cfg!(windows) { vec!["/c", &cmd] } else { vec!["-c", &cmd] })
            .output()
            .await
        {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                if output.status.success() {
                    if stderr.is_empty() {
                        stdout.to_string()
                    } else {
                        format!("{}\nstderr: {}", stdout, stderr)
                    }
                } else {
                    format!(
                        "Command failed (exit {})\nstdout: {}\nstderr: {}",
                        output.status.code().unwrap_or(-1),
                        stdout,
                        stderr
                    )
                }
            }
            Err(e) => format!("Failed to execute command: {}", e),
        }
    }

    /// Execute a built-in tool by calling the sidecar HTTP API.
    async fn execute_builtin(&self, name: &str, input: &serde_json::Value) -> String {
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

        let result = match name {
            "terminal_keys" => {
                let keys = input["keys"].as_str().unwrap_or("");
                let keys = keys.replace("\\n", "\r").replace("\\t", "\t");
                self.client
                    .post(build_target_url("/api/type"))
                    .body(keys)
                    .send()
                    .await
            }
            "terminal_split" => {
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
            "terminal_close" => {
                self.client
                    .post(format!("{}/api/pane/close", base))
                    .json(&serde_json::json!({}))
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
        description: "Create a new tool at runtime. The tool executes a shell command when called. Use {{input.fieldName}} in the command template for parameter substitution.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Tool name (snake_case)" },
                "description": { "type": "string", "description": "What the tool does" },
                "parameters": { "type": "object", "description": "JSON Schema for the tool's input parameters" },
                "command": { "type": "string", "description": "Shell command template. Use {{input.fieldName}} for substitution." }
            },
            "required": ["name", "description", "command"]
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
                    "pane": { "type": "string", "description": "Pane label e.g. \"a\" (optional)" }
                },
                "required": ["keys"]
            }
        },
        {
            "name": "terminal_split",
            "description": "Split the focused pane.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["horizontal", "vertical"] }
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
            "name": "terminal_close",
            "description": "Close the focused pane.",
            "input_schema": { "type": "object", "properties": {} }
        },
        {
            "name": "terminal_status",
            "description": "Get the current state of all windows, tabs, and panes.",
            "input_schema": { "type": "object", "properties": {} }
        },
        {
            "name": "terminal_screen",
            "description": "Read the current screen content of a pane as text.",
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
            "name": "file_read",
            "description": "Read a file from disk.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path to read" },
                    "max_lines": { "type": "integer", "description": "Max lines (default 200)" }
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
        }
    ]))
    .unwrap();

    defs.into_iter()
        .map(|v| serde_json::from_value(v).unwrap())
        .collect()
}
