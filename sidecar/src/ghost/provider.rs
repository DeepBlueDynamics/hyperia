use futures::StreamExt;
use tokio::sync::mpsc;

use super::types::{GhostConfig, ProviderEvent, ToolDef};

// ---------------------------------------------------------------------------
// AnyProvider — dispatch enum wrapping all supported backends
// ---------------------------------------------------------------------------

pub enum AnyProvider {
    Anthropic(AnthropicProvider),
    Ollama(OllamaProvider),
    /// Stub for not-yet-implemented providers (OpenAI, Gemini). Holds the
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
            "openai" => AnyProvider::Unsupported("openai".into()),
            "gemini" => AnyProvider::Unsupported("gemini".into()),
            other => AnyProvider::Unsupported(other.to_string()),
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

    let resp = req.send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let raw = resp.text().await.unwrap_or_default();
        anyhow::bail!("Ollama error {}: {}", status, raw);
    }

    let json: serde_json::Value = resp.json().await?;
    let content = json["message"]["content"].as_str()
        .ok_or_else(|| anyhow::anyhow!("No content in response"))?
        .to_string();

    let input_tokens = json["prompt_eval_count"].as_u64().unwrap_or(0);
    let output_tokens = json["eval_count"].as_u64().unwrap_or(0);

    // Parse the structured JSON
    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| anyhow::anyhow!("Invalid JSON syntax in candidate output: {}. Raw: {}", e, content))?;
    
    let thought = parsed["thought"].as_str().unwrap_or("").to_string();
    let reply = parsed["reply"].as_str().unwrap_or("").to_string();
    let tool_call = parsed.get("tool_call").cloned();

    // If there is a tool call, validate it
    if let Some(ref tc) = tool_call {
        if !tc.is_null() && tc.is_object() {
            if let Some(name) = tc["name"].as_str() {
                if name != "none" {
                    let arguments = &tc["arguments"];
                    
                    // Find the tool definition
                    if let Some(tool_def) = tools.iter().find(|t| t.name == name) {
                        if !validate_arguments(&tool_def.input_schema, arguments) {
                            anyhow::bail!("Invalid arguments for tool {}. Args: {}", name, arguments);
                        }
                    } else {
                        anyhow::bail!("Model called unknown tool {}", name);
                    }
                }
            } else {
                anyhow::bail!("Missing tool name in tool_call");
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
            "http://localhost:11434".to_string()
        } else {
            config.endpoint.trim_end_matches('/').to_string()
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
                out.push(serde_json::json!({
                    "role": role,
                    "content": msg["content"].as_str().unwrap_or(""),
                }));
                continue;
            }

            // Array content blocks (Anthropic format)
            if let Some(blocks) = msg["content"].as_array() {
                if role == "assistant" {
                    // Collect text and tool_use blocks
                    let mut text_parts: Vec<String> = Vec::new();
                    let mut tool_calls: Vec<serde_json::Value> = Vec::new();

                    for block in blocks {
                        match block["type"].as_str() {
                            Some("text") => {
                                if let Some(t) = block["text"].as_str() {
                                    text_parts.push(t.to_string());
                                }
                            }
                            Some("tool_use") => {
                                tool_calls.push(serde_json::json!({
                                    "function": {
                                        "name": block["name"],
                                        "arguments": block["input"],
                                    }
                                }));
                            }
                            _ => {}
                        }
                    }

                    let combined_text = text_parts.join("");
                    if !tool_calls.is_empty() {
                        out.push(serde_json::json!({
                            "role": "assistant",
                            "content": combined_text,
                            "tool_calls": tool_calls,
                        }));
                    } else {
                        out.push(serde_json::json!({
                            "role": "assistant",
                            "content": combined_text,
                        }));
                    }
                } else if role == "user" {
                    // User blocks may contain tool_result entries
                    for block in blocks {
                        match block["type"].as_str() {
                            Some("tool_result") => {
                                let content = block["content"]
                                    .as_str()
                                    .unwrap_or("")
                                    .to_string();
                                out.push(serde_json::json!({
                                    "role": "tool",
                                    "content": content,
                                }));
                            }
                            _ => {
                                // Plain text block in a user message
                                if let Some(t) = block["text"].as_str() {
                                    out.push(serde_json::json!({
                                        "role": "user",
                                        "content": t,
                                    }));
                                }
                            }
                        }
                    }
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
                    "tool_call": {
                        "type": "object",
                        "description": "An optional tool call to execute. Set name to 'none' and arguments to {} if you do not want to call any tool.",
                        "properties": {
                            "name": {
                                "type": "string",
                                "enum": tool_names
                            },
                            "arguments": {
                                "type": "object",
                                "description": "Exact JSON arguments matching the chosen tool's schema."
                            }
                        },
                        "required": ["name", "arguments"]
                    },
                    "reply": {
                        "type": "string",
                        "description": "Your final response to the user. Use this if you are not calling a tool (i.e., tool_call.name is 'none')."
                    }
                },
                "required": ["thought"]
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
            let mut last_error = None;

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
                    // All parallel candidates failed. Report the error.
                    let err_msg = format!(
                        "All parallel candidate generations failed. Last error: {}",
                        last_error.map(|e| e.to_string()).unwrap_or_else(|| "Unknown failure".into())
                    );
                    let _ = tx.send(ProviderEvent::Error(err_msg)).await;
                    return;
                }
            };

            // Emit usage stats
            if input_tokens > 0 || output_tokens > 0 {
                let _ = tx.send(ProviderEvent::Usage { input_tokens, output_tokens }).await;
            }

            // Emit the thinking reasoning block to the text delta channel so the user/agent sees thoughts
            if !thought.is_empty() {
                let formatted_thought = format!("[Thinking: {}]\n\n", thought);
                let _ = tx.send(ProviderEvent::TextDelta(formatted_thought)).await;
            }

            let mut had_tool_call = false;

            // Emit tool call event if generated
            if let Some(tc) = tool_call {
                if !tc.is_null() && tc.is_object() {
                    if let Some(name) = tc["name"].as_str() {
                        if name != "none" {
                            let arguments = &tc["arguments"];
                            let id = "ol_0".to_string(); // Single execution path id
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
