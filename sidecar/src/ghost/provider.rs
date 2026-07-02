use futures::StreamExt;
use tokio::sync::mpsc;

use super::types::{GhostConfig, ProviderEvent, ToolDef};

// ---------------------------------------------------------------------------
// AnyProvider — dispatch enum wrapping all supported backends
// ---------------------------------------------------------------------------

pub enum AnyProvider {
    Anthropic(AnthropicProvider),
    Ollama(OllamaProvider),
    OpenAI(OpenAIProvider),
    /// Stub for not-yet-implemented providers (Gemini). Holds the
    /// provider name so the error message can name it. Stream emits a
    /// single Error event explaining what's missing and returns.
    Unsupported(String),
}

impl AnyProvider {
    /// Dispatch on the explicit `config.provider` field. No string-prefix
    /// model magic — the routing decision lives in load_config so that
    /// there's a single source of truth.
    pub fn from_config(config: &GhostConfig) -> Self {
        match config.provider.as_str() {
            "anthropic" => AnyProvider::Anthropic(AnthropicProvider::new(config)),
            "ollama" => AnyProvider::Ollama(OllamaProvider::new(config)),
            "openai" => AnyProvider::OpenAI(OpenAIProvider::new(config)),
            "gemini" => AnyProvider::Unsupported("gemini".into()),
            other => AnyProvider::Unsupported(other.to_string()),
        }
    }

    pub fn provider_name(&self) -> &str {
        match self {
            AnyProvider::Anthropic(_) => "anthropic",
            AnyProvider::Ollama(_) => "ollama",
            AnyProvider::OpenAI(_) => "openai",
            AnyProvider::Unsupported(name) => name,
        }
    }

    pub fn model_name(&self) -> &str {
        match self {
            AnyProvider::Anthropic(p) => &p.model,
            AnyProvider::Ollama(p) => &p.model,
            AnyProvider::OpenAI(p) => &p.model,
            AnyProvider::Unsupported(_) => "",
        }
    }

    pub async fn stream(
        &self,
        system: &str,
        messages: &[serde_json::Value],
        tools: &[ToolDef],
        max_tokens: u32,
    ) -> anyhow::Result<mpsc::Receiver<ProviderEvent>> {
        match self {
            AnyProvider::Anthropic(p) => p.stream(system, messages, tools, max_tokens).await,
            AnyProvider::Ollama(p) => p.stream(system, messages, tools, max_tokens).await,
            AnyProvider::OpenAI(p) => p.stream(system, messages, tools, max_tokens).await,
            AnyProvider::Unsupported(name) => {
                let (tx, rx) = mpsc::channel(8);
                let msg = format!(
                    "Provider '{}' is not yet implemented in the sidecar. Switch to Anthropic or Ollama via the settings agent: 'change my model'. Tokens for additional providers can be stored at config.providers.<name>.token — when the provider lands here it'll pick them up automatically.",
                    name
                );
                let _ = tx.send(ProviderEvent::Error(msg)).await;
                Ok(rx)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------

pub struct AnthropicProvider {
    client: reqwest::Client,
    api_key: String,
    model: String,
    endpoint: String,
}

impl AnthropicProvider {
    pub fn new(config: &GhostConfig) -> Self {
        // No more string-prefix magic — the model id comes straight from
        // config.agent.model, which the settings agent writes via the
        // model_catalog → show_picker → settings_set flow. If it's empty
        // load_config has already defaulted it.
        let model = if config.model.is_empty() {
            "claude-sonnet-4-6".to_string()
        } else {
            config.model.clone()
        };
        let endpoint = if config.endpoint.is_empty() {
            "https://api.anthropic.com".to_string()
        } else {
            config.endpoint.trim_end_matches('/').to_string()
        };
        Self {
            client: reqwest::Client::new(),
            api_key: config.api_key.clone(),
            model,
            endpoint,
        }
    }

    /// Stream a Messages API request. Returns a receiver of ProviderEvents.
    pub async fn stream(
        &self,
        system: &str,
        messages: &[serde_json::Value],
        tools: &[ToolDef],
        max_tokens: u32,
    ) -> anyhow::Result<mpsc::Receiver<ProviderEvent>> {
        let (tx, rx) = mpsc::channel(128);

        let tool_defs: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect();

        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
            "tools": tool_defs,
            "stream": true,
        });

        // Retry up to 3 times on 529 overloaded with exponential backoff
        let mut attempt = 0u32;
        let resp = loop {
            let resp = self
                .client
                .post(format!("{}/v1/messages", self.endpoint))
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await?;

            if resp.status().as_u16() == 529 && attempt < 3 {
                attempt += 1;
                let wait_ms = 1000u64 * (1 << attempt); // 2s, 4s, 8s
                let _ = tx.send(ProviderEvent::Retrying {
                    attempt,
                    wait_secs: wait_ms / 1000,
                }).await;
                tokio::time::sleep(tokio::time::Duration::from_millis(wait_ms)).await;
                continue;
            }

            break resp;
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let raw = resp.text().await.unwrap_or_default();
            // Parse Anthropic error body for a clean message, but always include the raw body
            // Parse the Anthropic error body for a human-readable message first
            let api_message = serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|j| j["error"]["message"].as_str().map(|s| s.to_string()));
            let label = if status.as_u16() == 529 {
                format!("Anthropic overloaded (529) after {} retries — try again shortly.\nFull response: {}", attempt, raw)
            } else if status.as_u16() == 401 {
                format!("Invalid API key (401). Check your token in Settings.\nFull response: {}", raw)
            } else if let Some(msg) = api_message {
                format!("API error {} — {}\nFull response: {}", status, msg, raw)
            } else {
                format!("API error {} — {}", status, raw)
            };
            let _ = tx.send(ProviderEvent::Error(label)).await;
            return Ok(rx);
        }

        let mut stream = resp.bytes_stream();

        tokio::spawn(async move {
            let mut buffer = String::new();
            let mut current_event_type = String::new();

            while let Some(chunk) = stream.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(ProviderEvent::Error(e.to_string())).await;
                        break;
                    }
                };

                buffer.push_str(&String::from_utf8_lossy(&chunk));

                // Process complete SSE blocks (delimited by \n\n)
                while let Some(pos) = buffer.find("\n\n") {
                    let block = buffer[..pos].to_string();
                    buffer = buffer[pos + 2..].to_string();

                    for line in block.lines() {
                        if let Some(event_type) = line.strip_prefix("event: ") {
                            current_event_type = event_type.trim().to_string();
                        } else if let Some(data) = line.strip_prefix("data: ") {
                            if let Some(event) =
                                parse_sse_event(&current_event_type, data.trim())
                            {
                                if tx.send(event).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        });

        Ok(rx)
    }
}

fn parse_sse_event(event_type: &str, data: &str) -> Option<ProviderEvent> {
    let json: serde_json::Value = serde_json::from_str(data).ok()?;

    match event_type {
        "content_block_start" => {
            let block = &json["content_block"];
            match block["type"].as_str()? {
                "tool_use" => Some(ProviderEvent::ToolCallStart {
                    id: block["id"].as_str()?.to_string(),
                    name: block["name"].as_str()?.to_string(),
                }),
                _ => None,
            }
        }
        "content_block_delta" => {
            let delta = &json["delta"];
            match delta["type"].as_str()? {
                "text_delta" => Some(ProviderEvent::TextDelta(
                    delta["text"].as_str()?.to_string(),
                )),
                "input_json_delta" => Some(ProviderEvent::ToolCallDelta {
                    id: json["index"].to_string(),
                    json_fragment: delta["partial_json"].as_str()?.to_string(),
                }),
                _ => None,
            }
        }
        "content_block_stop" => {
            let index = json["index"].as_u64()?;
            Some(ProviderEvent::ToolCallEnd {
                id: index.to_string(),
            })
        }
        "message_delta" => {
            let delta = &json["delta"];
            let usage = &json["usage"];
            if let Some(reason) = delta["stop_reason"].as_str() {
                Some(ProviderEvent::MessageStop {
                    stop_reason: reason.to_string(),
                })
            } else if usage.is_object() {
                Some(ProviderEvent::Usage {
                    input_tokens: usage["input_tokens"].as_u64().unwrap_or(0),
                    output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
                })
            } else {
                None
            }
        }
        "message_stop" => None, // Already handled by message_delta stop_reason
        "ping" => None,
        "message_start" => {
            // input_tokens only appears in message_start
            let usage = &json["message"]["usage"];
            if usage.is_object() {
                Some(ProviderEvent::Usage {
                    input_tokens: usage["input_tokens"].as_u64().unwrap_or(0),
                    output_tokens: 0,
                })
            } else {
                None
            }
        }
        "error" => {
            let msg = json["error"]["message"]
                .as_str()
                .unwrap_or("Unknown API error");
            Some(ProviderEvent::Error(msg.to_string()))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// OllamaProvider — local Ollama via http://localhost:11434/api/chat
// ---------------------------------------------------------------------------

fn validate_arguments(schema: &serde_json::Value, args: &serde_json::Value) -> bool {
    let properties = match schema.get("properties").and_then(|p| p.as_object()) {
        Some(p) => p,
        None => return true,
    };

    if let Some(required) = schema.get("required").and_then(|r| r.as_array()) {
        for req in required {
            if let Some(req_str) = req.as_str() {
                if args.get(req_str).is_none() {
                    return false;
                }
            }
        }
    }

    if let Some(args_obj) = args.as_object() {
        for (key, val) in args_obj {
            if let Some(prop_schema) = properties.get(key) {
                if let Some(expected_type) = prop_schema.get("type").and_then(|t| t.as_str()) {
                    match expected_type {
                        "string" => if !val.is_string() { return false; },
                        "integer" | "number" => if !val.is_number() { return false; },
                        "boolean" => if !val.is_boolean() { return false; },
                        "array" => if !val.is_array() { return false; },
                        "object" => if !val.is_object() { return false; },
                        _ => {}
                    }
                }
            }
        }
    }

    true
}

#[derive(Debug)]
enum CandidateError {
    Http(String),
    JsonParse {
        raw_content: String,
        native_thinking: String,
        input_tokens: u64,
        output_tokens: u64,
        error_msg: String,
    },
    Validation(String),
}

impl std::fmt::Display for CandidateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CandidateError::Http(s) => write!(f, "HTTP error: {}", s),
            CandidateError::JsonParse { error_msg, .. } => write!(f, "JSON parse error: {}", error_msg),
            CandidateError::Validation(s) => write!(f, "Validation error: {}", s),
        }
    }
}

impl std::error::Error for CandidateError {}

fn extract_reply_fallback(raw: &str) -> String {
    if let Some(idx) = raw.find("\"reply\"") {
        let sub = &raw[idx..];
        if let Some(colon_idx) = sub.find(':') {
            let val_part = sub[colon_idx + 1..].trim();
            if val_part.starts_with('"') {
                let mut end_idx = None;
                let chars: Vec<char> = val_part.chars().collect();
                let mut escaped = false;
                for i in 1..chars.len() {
                    if escaped {
                        escaped = false;
                    } else if chars[i] == '\\' {
                        escaped = true;
                    } else if chars[i] == '"' {
                        end_idx = Some(i);
                        break;
                    }
                }
                if let Some(e) = end_idx {
                    let extracted: String = chars[1..e].iter().collect();
                    return extracted
                        .replace("\\\"", "\"")
                        .replace("\\n", "\n")
                        .replace("\\t", "\t");
                }
            }
        }
    }
    raw.to_string()
}

fn clean_and_parse_json(content: &str) -> anyhow::Result<serde_json::Value> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Empty content");
    }

    // 1. Try standard JSON parse
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return Ok(val);
    }

    // 2. Try parsing a JSON object from code fence/brackets block
    if let Some(start_idx) = trimmed.find('{') {
        if let Some(end_idx) = trimmed.rfind('}') {
            if end_idx > start_idx {
                let json_slice = &trimmed[start_idx..=end_idx];
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_slice) {
                    return Ok(val);
                }
            }
        }
    }

    // 3. Try parsing as a list/array
    if let Some(start_idx) = trimmed.find('[') {
        if let Some(end_idx) = trimmed.rfind(']') {
            if end_idx > start_idx {
                let json_slice = &trimmed[start_idx..=end_idx];
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_slice) {
                    return Ok(val);
                }
            }
        }
    }

    // 4. Return standard parse error
    let parsed: serde_json::Value = serde_json::from_str(trimmed)?;
    Ok(parsed)
}

async fn run_ollama_candidate(
    client: reqwest::Client,
    endpoint: String,
    api_key: String,
    model: String,
    ollama_messages: Vec<serde_json::Value>,
    format_schema: Option<serde_json::Value>,
    temperature: f64,
    tools: Vec<ToolDef>,
) -> anyhow::Result<(String, Option<serde_json::Value>, String, u64, u64)> {
    let mut body = serde_json::json!({
        "model": model,
        "messages": ollama_messages,
        "stream": false,
        "options": {
            "temperature": temperature,
        }
    });

    if let Some(schema) = format_schema {
        body["format"] = schema;
    }

    let mut req = client
        .post(format!("{}/api/chat", endpoint))
        .header("content-type", "application/json")
        .body(body.to_string());

    if !api_key.is_empty() {
        req = req.bearer_auth(&api_key);
    }

    let req_body_str = body.to_string();
    let resp = req.send().await?;
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();

    let log_content = format!(
        "=== REQUEST ===\n{}\n=== STATUS: {} ===\n=== RESPONSE ===\n{}\n",
        req_body_str, status, raw
    );
    let _ = std::fs::write("ollama_debug.log", log_content);

    if !status.is_success() {
        return Err(anyhow::Error::new(CandidateError::Http(format!("Ollama error {}: {}", status, raw))));
    }

    let json: serde_json::Value = serde_json::from_str(&raw)?;
    let content = json["message"]["content"].as_str()
        .ok_or_else(|| anyhow::anyhow!("No content in response"))?
        .to_string();

    let native_thinking = json["message"]["thinking"].as_str().unwrap_or("").to_string();

    let input_tokens = json["prompt_eval_count"].as_u64().unwrap_or(0);
    let output_tokens = json["eval_count"].as_u64().unwrap_or(0);

    // Parse the structured JSON
    let parsed: serde_json::Value = match clean_and_parse_json(&content) {
        Ok(v) => v,
        Err(e) => {
            return Err(anyhow::Error::new(CandidateError::JsonParse {
                raw_content: content,
                native_thinking,
                input_tokens,
                output_tokens,
                error_msg: e.to_string(),
            }));
        }
    };

    let mut thought = parsed["thought"].as_str().unwrap_or("").to_string();
    if thought.is_empty() && !native_thinking.is_empty() {
        thought = native_thinking;
    }
    let reply = parsed["reply"].as_str().unwrap_or("").to_string();
    
    // Remap flat fields back into nested tool_call format
    let tool_call = if let Some(name) = parsed["tool_name"].as_str() {
        let args = parsed.get("tool_arguments").cloned().unwrap_or(serde_json::json!({}));
        Some(serde_json::json!({
            "name": name,
            "arguments": args
        }))
    } else {
        parsed.get("tool_call").cloned()
    };

    // If there is a tool call, validate it
    if let Some(ref tc) = tool_call {
        if !tc.is_null() && tc.is_object() {
            if let Some(name) = tc["name"].as_str() {
                if name != "none" {
                    let arguments = &tc["arguments"];
                    
                    // Find the tool definition
                    if let Some(tool_def) = tools.iter().find(|t| t.name == name) {
                        if !validate_arguments(&tool_def.input_schema, arguments) {
                            return Err(anyhow::Error::new(CandidateError::Validation(format!("Invalid arguments for tool {}. Args: {}", name, arguments))));
                        }
                    } else {
                        return Err(anyhow::Error::new(CandidateError::Validation(format!("Model called unknown tool {}", name))));
                    }
                }
            } else {
                return Err(anyhow::Error::new(CandidateError::Validation("Missing tool name in tool_call".to_string())));
            }
        }
    }

    Ok((thought, tool_call, reply, input_tokens, output_tokens))
}

pub struct OllamaProvider {
    client: reqwest::Client,
    model: String,
    endpoint: String,
    /// Optional bearer token — only used for Ollama Cloud / custom proxies.
    /// Empty for default local Ollama.
    api_key: String,
}

impl OllamaProvider {
    pub fn new(config: &GhostConfig) -> Self {
        // Strip a legacy "ollama:" prefix in case an old config still has
        // it. New configs store the bare model name in config.agent.model.
        let model = config
            .model
            .strip_prefix("ollama:")
            .unwrap_or(&config.model)
            .to_string();
        let endpoint = if config.endpoint.is_empty() {
            if std::path::Path::new("/.dockerenv").exists() {
                "http://host.docker.internal:11434".to_string()
            } else {
                "http://localhost:11434".to_string()
            }
        } else {
            let mut ep = config.endpoint.trim_end_matches('/').to_string();
            if std::path::Path::new("/.dockerenv").exists() && (ep == "http://localhost:11434" || ep == "http://127.0.0.1:11434") {
                ep = "http://host.docker.internal:11434".to_string();
            }
            ep
        };
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            model,
            endpoint,
            api_key: config.api_key.clone(),
        }
    }

    /// Convert Anthropic-format messages + system prompt into Ollama chat format.
    fn build_ollama_messages(
        system: &str,
        messages: &[serde_json::Value],
    ) -> Vec<serde_json::Value> {
        let mut out = Vec::new();

        // System prompt as first message
        if !system.is_empty() {
            out.push(serde_json::json!({
                "role": "system",
                "content": system,
            }));
        }

        for msg in messages {
            let role = msg["role"].as_str().unwrap_or("user");

            // Simple string content — pass through
            if msg["content"].is_string() {
                let content_str = msg["content"].as_str().unwrap_or("");
                let final_content = if role == "assistant" {
                    if content_str.starts_with("[Thinking:") {
                        if let Some(end_idx) = content_str.find("]\n\n") {
                            let thought = &content_str[10..end_idx];
                            let reply = &content_str[end_idx + 3..];
                            serde_json::json!({
                                "thought": thought,
                                "reply": reply
                            }).to_string()
                        } else {
                            serde_json::json!({
                                "thought": "",
                                "reply": content_str
                            }).to_string()
                        }
                    } else {
                        // Try to parse the content string as JSON. If it is already a JSON string (reconstructed),
                        // pass it. Otherwise wrap it.
                        if serde_json::from_str::<serde_json::Value>(content_str).is_ok() {
                            content_str.to_string()
                        } else {
                            serde_json::json!({
                                "thought": "",
                                "reply": content_str
                            }).to_string()
                        }
                    }
                } else {
                    content_str.to_string()
                };

                out.push(serde_json::json!({
                    "role": role,
                    "content": final_content,
                }));
                continue;
            }

            // Array content blocks (Anthropic format)
            if let Some(blocks) = msg["content"].as_array() {
                if role == "assistant" {
                    // Collect text and tool_use blocks
                    let mut text_parts: Vec<String> = Vec::new();
                    let mut tool_name = None;
                    let mut tool_arguments = None;

                    for block in blocks {
                        match block["type"].as_str() {
                            Some("text") => {
                                if let Some(t) = block["text"].as_str() {
                                    text_parts.push(t.to_string());
                                }
                            }
                            Some("tool_use") => {
                                tool_name = block["name"].as_str().map(|s| s.to_string());
                                tool_arguments = Some(block["input"].clone());
                            }
                            _ => {}
                        }
                    }

                    let combined_text = text_parts.join("");
                    
                    // Reconstruct the JSON matching the schema format the model originally generated.
                    // This avoids confusing Ollama's template processor with native "tool_calls".
                    let content_json = if let Some(name) = tool_name {
                        serde_json::json!({
                            "thought": combined_text,
                            "tool_name": name,
                            "tool_arguments": tool_arguments.unwrap_or(serde_json::json!({}))
                        })
                    } else {
                        let mut reply = combined_text;
                        let mut thought = String::new();
                        if reply.starts_with("[Thinking:") {
                            if let Some(end_idx) = reply.find("]\n\n") {
                                thought = reply[10..end_idx].to_string();
                                reply = reply[end_idx + 3..].to_string();
                            }
                        }
                        serde_json::json!({
                            "thought": thought,
                            "reply": reply
                        })
                    };

                    out.push(serde_json::json!({
                        "role": "assistant",
                        "content": content_json.to_string(),
                    }));
                } else if role == "user" {
                    // User blocks may contain tool_result entries
                    let mut user_texts = Vec::new();
                    for block in blocks {
                        match block["type"].as_str() {
                            Some("tool_result") => {
                                if let Some(content) = block["content"].as_str() {
                                    user_texts.push(format!("Tool result:\n{}", content));
                                }
                            }
                            _ => {
                                // Plain text block in a user message
                                if let Some(t) = block["text"].as_str() {
                                    user_texts.push(t.to_string());
                                }
                            }
                        }
                    }
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": user_texts.join("\n\n"),
                    }));
                }
            }
        }

        out
    }

    pub async fn stream(
        &self,
        system: &str,
        messages: &[serde_json::Value],
        tools: &[ToolDef],
        _max_tokens: u32,
    ) -> anyhow::Result<mpsc::Receiver<ProviderEvent>> {
        let (tx, rx) = mpsc::channel(128);

        let ollama_messages = Self::build_ollama_messages(system, messages);
        let active_tools = tools.to_vec();

        // 1. Build the dynamic structured JSON Schema matching un-throttled tools
        let mut tool_names = Vec::new();
        if !tools.is_empty() {
            tool_names.push("none".to_string());
            for t in tools {
                tool_names.push(t.name.clone());
            }
        }

        let format_schema = if !tools.is_empty() {
            Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "thought": {
                        "type": "string",
                        "description": "Your internal reasoning process. Explain why you are calling a tool or why you are just replying."
                    },
                    "tool_name": {
                        "type": "string",
                        "description": "The name of the tool to execute. Set to 'none' if you do not want to call any tool.",
                        "enum": tool_names
                    },
                    "tool_arguments": {
                        "type": "object",
                        "description": "Exact JSON arguments matching the chosen tool's schema. Set to {} if tool_name is 'none'."
                    },
                    "reply": {
                        "type": "string",
                        "description": "Your final response to the user. Use this if you are not calling a tool (i.e., tool_name is 'none')."
                    }
                },
                "required": ["thought", "tool_name", "tool_arguments"]
            }))
        } else {
            Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "thought": {
                        "type": "string",
                        "description": "Your internal reasoning process."
                    },
                    "reply": {
                        "type": "string",
                        "description": "Your direct response to the user."
                    }
                },
                "required": ["thought", "reply"]
            }))
        };

        // 2. Parallel Candidate Generation (temperatures: 0.1, 0.4, 0.7)
        let client = self.client.clone();
        let endpoint = self.endpoint.clone();
        let api_key = self.api_key.clone();
        let model = self.model.clone();

        tokio::spawn(async move {
            let mut candidates = Vec::new();
            
            // Spawn 3 candidate futures in parallel
            let temp_list = vec![0.1, 0.4, 0.7];
            for temp in temp_list {
                let candidate_fut = run_ollama_candidate(
                    client.clone(),
                    endpoint.clone(),
                    api_key.clone(),
                    model.clone(),
                    ollama_messages.clone(),
                    format_schema.clone(),
                    temp,
                    active_tools.clone(),
                );
                candidates.push(Box::pin(candidate_fut) as std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<(String, Option<serde_json::Value>, String, u64, u64)>> + Send>>);
            }

            // We await candidates using futures::future::select_all to grab the first one that succeeds.
            // If one succeeds, we drop all other candidates (canceling their in-flight HTTP requests).
            let mut matched_candidate = None;
            let mut last_error: Option<anyhow::Error> = None;

            while !candidates.is_empty() {
                let (res, _index, remaining) = futures::future::select_all(candidates).await;
                candidates = remaining;

                match res {
                    Ok(val) => {
                        matched_candidate = Some(val);
                        break;
                    }
                    Err(e) => {
                        tracing::warn!("Ollama candidate generation failed: {}", e);
                        last_error = Some(e);
                    }
                }
            }

            let (thought, tool_call, reply, input_tokens, output_tokens) = match matched_candidate {
                Some(val) => val,
                None => {
                    // Try to downcast last_error to CandidateError::JsonParse to perform robust fallback.
                    // This allows local models that get lazy and reply with raw text to still finish successfully.
                    let mut fallback = None;
                    if let Some(ref err) = last_error {
                        if let Some(CandidateError::JsonParse { raw_content, native_thinking, input_tokens, output_tokens, .. }) = err.downcast_ref::<CandidateError>() {
                            tracing::info!("All candidates failed JSON parsing. Falling back to raw content as reply.");
                            let mut reply = extract_reply_fallback(raw_content);
                            if reply.starts_with("```") {
                                // Strip code fences
                                let lines: Vec<&str> = reply.lines().collect();
                                if lines.len() >= 2 && lines.first().unwrap().starts_with("```") && lines.last().unwrap().starts_with("```") {
                                    reply = lines[1..lines.len()-1].join("\n").trim().to_string();
                                }
                            }
                            fallback = Some((native_thinking.clone(), None, reply, *input_tokens, *output_tokens));
                        }
                    }

                    if let Some(val) = fallback {
                        val
                    } else {
                        // All parallel candidates failed. Report the error.
                        let err_msg = format!(
                            "All parallel candidate generations failed. Last error: {}",
                            last_error.map(|e| e.to_string()).unwrap_or_else(|| "Unknown failure".into())
                        );
                        let _ = tx.send(ProviderEvent::Error(err_msg)).await;
                        return;
                    }
                }
            };

            // Emit usage stats
            if input_tokens > 0 || output_tokens > 0 {
                let _ = tx.send(ProviderEvent::Usage { input_tokens, output_tokens }).await;
            }

            // Emit the thinking reasoning block via structured thinking events
            if !thought.is_empty() {
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let id = format!("think_{}", timestamp);
                let _ = tx.send(ProviderEvent::ThinkingStart { id: id.clone() }).await;
                // Stream the thought word-by-word to make it feel alive and responsive in the UI
                let words: Vec<&str> = thought.split_whitespace().collect();
                for (i, word) in words.iter().enumerate() {
                    let mut chunk = word.to_string();
                    if i > 0 {
                        chunk = format!(" {}", chunk);
                    }
                    let _ = tx.send(ProviderEvent::ThinkingDelta { id: id.clone(), text: chunk }).await;
                    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
                }
                let _ = tx.send(ProviderEvent::ThinkingEnd { id }).await;
            }

            let mut had_tool_call = false;

            // Emit tool call event if generated
            if let Some(tc) = tool_call {
                if !tc.is_null() && tc.is_object() {
                    if let Some(name) = tc["name"].as_str() {
                        if name != "none" {
                            let arguments = &tc["arguments"];
                            let timestamp = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_nanos())
                                .unwrap_or(0);
                            let id = format!("ol_{}", timestamp);
                            had_tool_call = true;

                            let _ = tx.send(ProviderEvent::ToolCallStart {
                                id: id.clone(),
                                name: name.to_string(),
                            }).await;

                            let _ = tx.send(ProviderEvent::ToolCallDelta {
                                id: id.clone(),
                                json_fragment: arguments.to_string(),
                                }).await;

                            let _ = tx.send(ProviderEvent::ToolCallEnd { id }).await;
                        }
                    }
                }
            }

            // Emit final direct reply
            if !reply.is_empty() {
                let _ = tx.send(ProviderEvent::TextDelta(reply)).await;
            }

            // Emit completion stop reason
            let stop_reason = if had_tool_call {
                "tool_use".to_string()
            } else {
                "end_turn".to_string()
            };
            let _ = tx.send(ProviderEvent::MessageStop { stop_reason }).await;
        });

        Ok(rx)
    }
}

// ---------------------------------------------------------------------------
// OpenAIProvider — implementation for OpenAI chat completion endpoint
// ---------------------------------------------------------------------------

pub struct OpenAIProvider {
    client: reqwest::Client,
    api_key: String,
    pub model: String,
    endpoint: String,
}

impl OpenAIProvider {
    pub fn new(config: &GhostConfig) -> Self {
        let model = if config.model.is_empty() {
            "gpt-4o".to_string()
        } else {
            config.model.clone()
        };
        let endpoint = if config.endpoint.is_empty() {
            "https://api.openai.com".to_string()
        } else {
            config.endpoint.trim_end_matches('/').to_string()
        };
        Self {
            client: reqwest::Client::new(),
            api_key: config.api_key.clone(),
            model,
            endpoint,
        }
    }

    pub async fn stream(
        &self,
        system: &str,
        messages: &[serde_json::Value],
        tools: &[ToolDef],
        max_tokens: u32,
    ) -> anyhow::Result<mpsc::Receiver<ProviderEvent>> {
        let (tx, rx) = mpsc::channel(128);

        let openai_messages = build_openai_messages(system, messages);

        let mut body = serde_json::json!({
            "model": self.model,
            "messages": openai_messages,
            "stream": true,
            "stream_options": {
                "include_usage": true
            }
        });

        if max_tokens > 0 {
            // api.openai.com rejects `max_tokens` on reasoning/gpt-5.x models
            // ("use max_completion_tokens"); it accepts max_completion_tokens on
            // all current chat models. OpenAI-COMPATIBLE servers (llama.cpp /
            // Sailfish, vLLM, Ollama) generally only know `max_tokens`, so key
            // off the endpoint.
            if self.endpoint.contains("api.openai.com") {
                body["max_completion_tokens"] = serde_json::json!(max_tokens);
            } else {
                body["max_tokens"] = serde_json::json!(max_tokens);
            }
        }

        if !tools.is_empty() {
            let tool_defs: Vec<serde_json::Value> = tools
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.input_schema,
                        }
                    })
                })
                .collect();
            body["tools"] = serde_json::json!(tool_defs);
        }

        let resp = self
            .client
            .post(format!("{}/v1/chat/completions", self.endpoint))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let raw = resp.text().await.unwrap_or_default();
            let api_message = serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|j| j["error"]["message"].as_str().map(|s| s.to_string()));
            let label = if let Some(msg) = api_message {
                format!("OpenAI error {} — {}\nFull response: {}", status, msg, raw)
            } else {
                format!("OpenAI error {} — {}", status, raw)
            };
            let _ = tx.send(ProviderEvent::Error(label)).await;
            return Ok(rx);
        }

        let mut stream = resp.bytes_stream();

        tokio::spawn(async move {
            let mut buffer = String::new();
            let mut active_tool_calls: std::collections::HashMap<u64, (String, String)> = std::collections::HashMap::new();
            let mut sent_thinking_start = false;
            let think_id = format!(
                "think_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );

            while let Some(chunk) = stream.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(ProviderEvent::Error(e.to_string())).await;
                        break;
                    }
                };

                buffer.push_str(&String::from_utf8_lossy(&chunk));

                while let Some(pos) = buffer.find("\n\n") {
                    let block = buffer[..pos].to_string();
                    buffer = buffer[pos + 2..].to_string();

                    for line in block.lines() {
                        let line_trimmed = line.trim();
                        if line_trimmed.is_empty() {
                            continue;
                        }
                        if line_trimmed == "data: [DONE]" {
                            break;
                        }
                        if let Some(data) = line_trimmed.strip_prefix("data:") {
                            let data_trimmed = data.trim();
                            if data_trimmed.is_empty() {
                                continue;
                            }
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(data_trimmed) {
                                // 1. Usage stats
                                if let Some(usage) = val["usage"].as_object() {
                                    let input_tokens = usage["prompt_tokens"].as_u64().unwrap_or(0);
                                    let output_tokens = usage["completion_tokens"].as_u64().unwrap_or(0);
                                    if input_tokens > 0 || output_tokens > 0 {
                                        let _ = tx.send(ProviderEvent::Usage { input_tokens, output_tokens }).await;
                                    }
                                }

                                if let Some(choices) = val["choices"].as_array() {
                                    if let Some(choice) = choices.first() {
                                        let delta = &choice["delta"];

                                        // 2. Text delta
                                        if let Some(content) = delta["content"].as_str() {
                                            if !content.is_empty() {
                                                if sent_thinking_start {
                                                    let _ = tx.send(ProviderEvent::ThinkingEnd { id: think_id.clone() }).await;
                                                    sent_thinking_start = false;
                                                }
                                                let _ = tx.send(ProviderEvent::TextDelta(content.to_string())).await;
                                            }
                                        }

                                        // 3. Reasoning delta
                                        if let Some(reasoning) = delta["reasoning_content"].as_str().or_else(|| delta["reasoning"].as_str()) {
                                            if !reasoning.is_empty() {
                                                if !sent_thinking_start {
                                                    let _ = tx.send(ProviderEvent::ThinkingStart { id: think_id.clone() }).await;
                                                    sent_thinking_start = true;
                                                }
                                                let _ = tx.send(ProviderEvent::ThinkingDelta {
                                                    id: think_id.clone(),
                                                    text: reasoning.to_string(),
                                                }).await;
                                            }
                                        }

                                        // 4. Tool calls delta
                                        if let Some(tool_calls) = delta["tool_calls"].as_array() {
                                            if sent_thinking_start {
                                                let _ = tx.send(ProviderEvent::ThinkingEnd { id: think_id.clone() }).await;
                                                sent_thinking_start = false;
                                            }
                                            for tc in tool_calls {
                                                let index = tc["index"].as_u64().unwrap_or(0);
                                                if let Some(id) = tc["id"].as_str() {
                                                    let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                                                    let id_str = id.to_string();
                                                    active_tool_calls.insert(index, (id_str.clone(), name.clone()));
                                                    let _ = tx.send(ProviderEvent::ToolCallStart {
                                                        id: id_str,
                                                        name,
                                                    }).await;
                                                }
                                                if let Some(args) = tc["function"]["arguments"].as_str() {
                                                    if let Some((id, _name)) = active_tool_calls.get(&index) {
                                                        let _ = tx.send(ProviderEvent::ToolCallDelta {
                                                            id: id.clone(),
                                                            json_fragment: args.to_string(),
                                                        }).await;
                                                    }
                                                }
                                            }
                                        }

                                        // 5. Message stop reason
                                        if let Some(finish_reason) = choice["finish_reason"].as_str() {
                                            let stop_reason = match finish_reason {
                                                "tool_calls" => "tool_use",
                                                _ => "end_turn",
                                            };
                                            let _ = tx.send(ProviderEvent::MessageStop { stop_reason: stop_reason.to_string() }).await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if sent_thinking_start {
                let _ = tx.send(ProviderEvent::ThinkingEnd { id: think_id }).await;
            }
            for (_index, (id, _name)) in active_tool_calls {
                let _ = tx.send(ProviderEvent::ToolCallEnd { id }).await;
            }
        });

        Ok(rx)
    }
}

fn build_openai_messages(system: &str, messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();

    if !system.is_empty() {
        out.push(serde_json::json!({
            "role": "system",
            "content": system,
        }));
    }

    for msg in messages {
        let role = msg["role"].as_str().unwrap_or("user");

        if msg["content"].is_string() {
            let content_str = msg["content"].as_str().unwrap_or("");
            out.push(serde_json::json!({
                "role": role,
                "content": content_str,
            }));
        } else if msg["content"].is_array() {
            if role == "user" {
                for block in msg["content"].as_array().unwrap() {
                    if block["type"] == "tool_result" {
                        let tool_use_id = block["tool_use_id"].as_str().unwrap_or("").to_string();
                        let content_val = block["content"].clone();
                        let content_str = if content_val.is_string() {
                            content_val.as_str().unwrap_or("").to_string()
                        } else {
                            content_val.to_string()
                        };
                        out.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": tool_use_id,
                            "content": content_str,
                        }));
                    } else if block["type"] == "text" {
                        let text = block["text"].as_str().unwrap_or("");
                        out.push(serde_json::json!({
                            "role": "user",
                            "content": text,
                        }));
                    }
                }
            } else if role == "assistant" {
                let mut text_content = String::new();
                let mut tool_calls = Vec::new();
                for block in msg["content"].as_array().unwrap() {
                    if block["type"] == "text" {
                        if let Some(txt) = block["text"].as_str() {
                            text_content.push_str(txt);
                        }
                    } else if block["type"] == "tool_use" {
                        let id = block["id"].as_str().unwrap_or("").to_string();
                        let name = block["name"].as_str().unwrap_or("").to_string();
                        let input = block["input"].clone();
                        tool_calls.push(serde_json::json!({
                            "id": id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": input.to_string(),
                            }
                        }));
                    }
                }
                let mut assistant_msg = serde_json::json!({
                    "role": "assistant",
                });
                if !text_content.is_empty() {
                    assistant_msg["content"] = serde_json::json!(text_content);
                } else {
                    assistant_msg["content"] = serde_json::Value::Null;
                }
                if !tool_calls.is_empty() {
                    assistant_msg["tool_calls"] = serde_json::json!(tool_calls);
                }
                out.push(assistant_msg);
            }
        }
    }

    out
}
