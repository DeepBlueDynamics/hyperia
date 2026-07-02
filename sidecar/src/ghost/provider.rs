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
            // Sailfish is a local OpenAI-compatible endpoint (llama.cpp CUDA,
            // http://localhost:22343/v1). It rides OpenAIProvider verbatim — the
            // only difference is provider_name() reports "sailfish" (via the
            // provider_label carried on OpenAIProvider from config.provider).
            "sailfish" => AnyProvider::OpenAI(OpenAIProvider::new(config)),
            "gemini" => AnyProvider::Unsupported("gemini".into()),
            other => AnyProvider::Unsupported(other.to_string()),
        }
    }

    pub fn provider_name(&self) -> &str {
        match self {
            AnyProvider::Anthropic(_) => "anthropic",
            AnyProvider::Ollama(_) => "ollama",
            // "openai" or "sailfish" — both ride OpenAIProvider; the label is
            // carried from config.provider so doors/telemetry can tell them apart.
            AnyProvider::OpenAI(p) => &p.provider_label,
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
            crate::models::default_model("anthropic").to_string()
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
                // Take up to the closing quote — or, when the generation was
                // truncated mid-string (token cap) and there IS no closing
                // quote, take everything to the end. A cut-off sentence beats
                // showing the user a raw JSON fragment.
                let e = end_idx.unwrap_or(chars.len());
                let extracted: String = chars[1..e].iter().collect();
                return extracted
                    .replace("\\\"", "\"")
                    .replace("\\n", "\n")
                    .replace("\\t", "\t");
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

/// Live-streaming single-shot Ollama generation (temperature 0.1). Streams
/// native `message.thinking` deltas to the UI AS THE MODEL GENERATES — the
/// blocking candidate path sits silent for the whole generation (~60s on
/// ornith) and then fake-streams the finished thought. `message.content`
/// (the structured JSON) is accumulated and parsed at the end, with the same
/// validation as run_ollama_candidate. Returns the candidate tuple plus a
/// flag: was thinking already streamed live (so the caller doesn't replay it).
async fn run_ollama_streaming(
    client: reqwest::Client,
    endpoint: String,
    api_key: String,
    model: String,
    ollama_messages: Vec<serde_json::Value>,
    format_schema: Option<serde_json::Value>,
    tools: Vec<ToolDef>,
    tx: &mpsc::Sender<ProviderEvent>,
) -> anyhow::Result<(String, Option<serde_json::Value>, String, u64, u64, bool)> {
    let mut body = serde_json::json!({
        "model": model,
        "messages": ollama_messages,
        "stream": true,
        "options": { "temperature": 0.1 }
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
        return Err(anyhow::Error::new(CandidateError::Http(format!(
            "Ollama error {}: {}",
            status, raw
        ))));
    }

    // Ollama streams NDJSON — one JSON object per line; message.thinking and
    // message.content are per-chunk DELTAS. Final line has done:true + usage.
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut content = String::new();
    let mut native_thinking = String::new();
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut think_id: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf = buf[pos + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if let Some(t) = val["message"]["thinking"].as_str() {
                if !t.is_empty() {
                    let first = native_thinking.is_empty();
                    native_thinking.push_str(t);
                    let id = think_id
                        .get_or_insert_with(|| {
                            format!(
                                "think_{}",
                                std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_nanos())
                                    .unwrap_or(0)
                            )
                        })
                        .clone();
                    if first {
                        let _ = tx.send(ProviderEvent::ThinkingStart { id: id.clone() }).await;
                    }
                    let _ = tx
                        .send(ProviderEvent::ThinkingDelta { id, text: t.to_string() })
                        .await;
                }
            }
            if let Some(c) = val["message"]["content"].as_str() {
                content.push_str(c);
            }
            if val["done"].as_bool() == Some(true) {
                input_tokens = val["prompt_eval_count"].as_u64().unwrap_or(0);
                output_tokens = val["eval_count"].as_u64().unwrap_or(0);
            }
        }
    }
    if let Some(id) = think_id.clone() {
        let _ = tx.send(ProviderEvent::ThinkingEnd { id }).await;
    }
    let streamed_thinking = think_id.is_some();

    // Debug dump, mirroring the blocking path's ollama_debug.log.
    let _ = std::fs::write(
        "ollama_debug.log",
        format!(
            "=== STREAMED REQUEST ===\n{}\n=== CONTENT ===\n{}\n=== NATIVE THINKING ===\n{}\n",
            body, content, native_thinking
        ),
    );

    // Parse + validate exactly like the blocking candidate path.
    let parsed = clean_and_parse_json(&content).map_err(|e| {
        anyhow::Error::new(CandidateError::JsonParse {
            raw_content: content.clone(),
            native_thinking: native_thinking.clone(),
            input_tokens,
            output_tokens,
            error_msg: e.to_string(),
        })
    })?;

    let mut thought = parsed["thought"].as_str().unwrap_or("").to_string();
    if thought.is_empty() && !native_thinking.is_empty() {
        thought = native_thinking;
    }
    let reply = parsed["reply"].as_str().unwrap_or("").to_string();
    let tool_call = if let Some(name) = parsed["tool_name"].as_str() {
        let args = parsed
            .get("tool_arguments")
            .cloned()
            .unwrap_or(serde_json::json!({}));
        Some(serde_json::json!({ "name": name, "arguments": args }))
    } else {
        parsed.get("tool_call").cloned()
    };
    if let Some(ref tc) = tool_call {
        if !tc.is_null() && tc.is_object() {
            if let Some(name) = tc["name"].as_str() {
                if name != "none" {
                    let arguments = &tc["arguments"];
                    if let Some(tool_def) = tools.iter().find(|t| t.name == name) {
                        if !validate_arguments(&tool_def.input_schema, arguments) {
                            return Err(anyhow::Error::new(CandidateError::Validation(format!(
                                "Invalid arguments for tool {}. Args: {}",
                                name, arguments
                            ))));
                        }
                    } else {
                        return Err(anyhow::Error::new(CandidateError::Validation(format!(
                            "Model called unknown tool {}",
                            name
                        ))));
                    }
                }
            } else {
                return Err(anyhow::Error::new(CandidateError::Validation(
                    "Missing tool name in tool_call".to_string(),
                )));
            }
        }
    }

    Ok((thought, tool_call, reply, input_tokens, output_tokens, streamed_thinking))
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
            // Door names are callable too — agent.rs treats a bare door-name
            // call as open_tools(door=...). The enum IS a structured-output
            // model's entire tool universe: without door names it literally
            // cannot reach behind a closed door ("split the pane" dead-ended
            // in "I don't have terminal_split" because terminal_split wasn't
            // in the enum and neither was any way to open its door).
            for d in crate::doors::doors_for(crate::doors::Surface::Ghost) {
                if !d.ghost_tools.is_empty() {
                    let n = d.name.to_string();
                    if !tool_names.contains(&n) {
                        tool_names.push(n);
                    }
                }
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
                        "description": "REQUIRED. Your final answer to the user's question — shown to them verbatim. MUST be \"\" when tool_name is not 'none'; never narrate tool calls here."
                    }
                },
                // reply IS required — ornith emitted thought + tool_name:"none"
                // and legally omitted reply (it wasn't listed), rendering as
                // thinking followed by pure silence in the shell.
                "required": ["thought", "tool_name", "tool_arguments", "reply"]
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
            // Attempt 1: live-streaming single generation (temp 0.1). Thinking
            // reaches the shell AS IT GENERATES instead of after a ~60s silent
            // wait, and a single generation avoids the 3× parallel-candidate
            // VRAM contention that made 12B models flaky on a 12GB card.
            let streamed = run_ollama_streaming(
                client.clone(),
                endpoint.clone(),
                api_key.clone(),
                model.clone(),
                ollama_messages.clone(),
                format_schema.clone(),
                active_tools.clone(),
                &tx,
            )
            .await;

            let (thought, tool_call, reply, input_tokens, output_tokens, thinking_streamed_live) = match streamed {
                Ok(v) => v,
                Err(stream_err) => {
                    if let Some(CandidateError::JsonParse { raw_content, native_thinking, input_tokens, output_tokens, .. }) = stream_err.downcast_ref::<CandidateError>() {
                        // The generation itself succeeded but the structured JSON
                        // didn't parse — use the raw content as the reply directly
                        // instead of burning three more generations re-asking.
                        tracing::info!("streamed generation failed JSON parse — using raw content as reply");
                        let mut reply = extract_reply_fallback(raw_content);
                        if reply.starts_with("```") {
                            let lines: Vec<&str> = reply.lines().collect();
                            if lines.len() >= 2 && lines.first().unwrap().starts_with("```") && lines.last().unwrap().starts_with("```") {
                                reply = lines[1..lines.len()-1].join("\n").trim().to_string();
                            }
                        }
                        // Any native thinking was already streamed live as it arrived.
                        (native_thinking.clone(), None, reply, *input_tokens, *output_tokens, true)
                    } else {
                        // Transport/validation failure — fall back to the blocking
                        // parallel candidates (3 temperatures, first success wins).
                        tracing::warn!("Ollama streaming attempt failed ({}), falling back to parallel candidates", stream_err);
                        let mut candidates = Vec::new();
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

                        match matched_candidate {
                            Some((t, tc, r, i, o)) => (t, tc, r, i, o, false),
                            None => {
                                // Lazy-model fallback: raw text as the reply.
                                let mut fallback = None;
                                if let Some(ref err) = last_error {
                                    if let Some(CandidateError::JsonParse { raw_content, native_thinking, input_tokens, output_tokens, .. }) = err.downcast_ref::<CandidateError>() {
                                        tracing::info!("All candidates failed JSON parsing. Falling back to raw content as reply.");
                                        let mut reply = extract_reply_fallback(raw_content);
                                        if reply.starts_with("```") {
                                            let lines: Vec<&str> = reply.lines().collect();
                                            if lines.len() >= 2 && lines.first().unwrap().starts_with("```") && lines.last().unwrap().starts_with("```") {
                                                reply = lines[1..lines.len()-1].join("\n").trim().to_string();
                                            }
                                        }
                                        fallback = Some((native_thinking.clone(), None, reply, *input_tokens, *output_tokens, false));
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
                        }
                    }
                }
            };

            // Emit usage stats
            if input_tokens > 0 || output_tokens > 0 {
                let _ = tx.send(ProviderEvent::Usage { input_tokens, output_tokens }).await;
            }

            // Emit the thinking reasoning block via structured thinking events
            // — unless it already streamed live during generation.
            if !thinking_streamed_live && !thought.is_empty() {
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

            // Emit final direct reply — but ONLY on non-tool turns. Now that
            // `reply` is required, small models fill it with self-narration on
            // every tool call ("I'm checking the status…"); emitting that per
            // turn renders as the agent talking to itself while it polls. On
            // tool turns the thinking row already shows the reasoning — the
            // user-visible reply belongs to the turn that ANSWERS.
            // Belt-and-suspenders: a no-tool turn with an empty reply promotes
            // the thought instead of saying nothing.
            if !had_tool_call {
                if !reply.is_empty() {
                    let _ = tx.send(ProviderEvent::TextDelta(reply)).await;
                } else if !thought.is_empty() {
                    let _ = tx.send(ProviderEvent::TextDelta(thought.clone())).await;
                }
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
    /// Send `temperature: 0` on tool turns. True only when doors mode is active
    /// AND the endpoint is an OpenAI-compatible server (NOT api.openai.com) —
    /// the Sailfish guide asks for temperature 0 on tool calls, and cloud
    /// OpenAI o-series models reject the `temperature` field outright.
    send_zero_temp: bool,
    /// The configured provider id ("openai" or "sailfish"). Reported by
    /// `AnyProvider::provider_name()` so a Sailfish run is distinguishable from
    /// a stock OpenAI run even though they share this provider implementation.
    provider_label: String,
}

impl OpenAIProvider {
    pub fn new(config: &GhostConfig) -> Self {
        let model = if config.model.is_empty() {
            crate::models::default_model("openai").to_string()
        } else {
            config.model.clone()
        };
        let endpoint = if config.endpoint.is_empty() {
            "https://api.openai.com".to_string()
        } else {
            config.endpoint.trim_end_matches('/').to_string()
        };
        let send_zero_temp = config.doors.enabled && !endpoint.contains("api.openai.com");
        let provider_label = if config.provider.is_empty() {
            "openai".to_string()
        } else {
            config.provider.clone()
        };
        Self {
            // No request-level timeout on the client: the Sailfish appliance can
            // take ~120 s to answer the first call after idle (model/graph warm,
            // per HYPERIA_INTEGRATION.md). A reqwest timeout here would abort the
            // warmup; instead we let the stream run and the shell shows progress.
            client: reqwest::Client::new(),
            api_key: config.api_key.clone(),
            model,
            endpoint,
            send_zero_temp,
            provider_label,
        }
    }

    pub async fn stream(
        &self,
        system: &str,
        messages: &[serde_json::Value],
        tools: &[ToolDef],
        max_tokens: u32,
    ) -> anyhow::Result<mpsc::Receiver<ProviderEvent>> {
        // Newer OpenAI models (gpt-5-codex, *-pro, *-deep-research) are only
        // served by the /v1/responses endpoint and 404 on /v1/chat/completions
        // ("Use the v1/responses endpoint instead"). Route them there.
        if needs_responses_api(&self.model) {
            return self.stream_responses(system, messages, tools, max_tokens).await;
        }

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
            if crate::models::uses_max_completion_tokens(&self.endpoint) {
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

            // Sailfish/compat guide: deterministic tool selection wants
            // temperature 0 on tool turns. Guarded to non-api.openai.com
            // endpoints (cloud o-series rejects `temperature`); see new().
            if self.send_zero_temp {
                body["temperature"] = serde_json::json!(0);
            }
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
            // Name the ACTUAL provider, not "OpenAI" — Sailfish/vLLM/etc. ride
            // this same code path, and labeling every failure "OpenAI error"
            // makes a local model look like a cloud one. Include the host so
            // it's unambiguous which endpoint answered.
            let host = self
                .endpoint
                .trim_start_matches("https://")
                .trim_start_matches("http://");
            let who = format!("{} ({})", self.provider_label, host);
            let label = if let Some(msg) = api_message {
                format!("{} error {} — {}\nFull response: {}", who, status, msg, raw)
            } else {
                format!("{} error {} — {}", who, status, raw)
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

    /// Stream via OpenAI's /v1/responses endpoint (the newer unified API).
    /// Required for gpt-5-codex / *-pro / *-deep-research; those 404 on
    /// chat/completions. Different request shape (flat tools, `instructions`,
    /// `input` items, `max_output_tokens`) and a typed-event SSE stream.
    pub async fn stream_responses(
        &self,
        system: &str,
        messages: &[serde_json::Value],
        tools: &[ToolDef],
        max_tokens: u32,
    ) -> anyhow::Result<mpsc::Receiver<ProviderEvent>> {
        let (tx, rx) = mpsc::channel(128);

        let mut body = serde_json::json!({
            "model": self.model,
            "input": build_responses_input(messages),
            "stream": true,
        });
        if !system.is_empty() {
            body["instructions"] = serde_json::json!(system);
        }
        if max_tokens > 0 {
            body["max_output_tokens"] = serde_json::json!(max_tokens);
        }
        if !tools.is_empty() {
            // Responses tools are FLAT (name/description/parameters at top level),
            // unlike chat/completions which nests under `function`.
            let tool_defs: Vec<serde_json::Value> = tools
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "type": "function",
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    })
                })
                .collect();
            body["tools"] = serde_json::json!(tool_defs);
        }

        let resp = self
            .client
            .post(format!("{}/v1/responses", self.endpoint))
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
            let host = self
                .endpoint
                .trim_start_matches("https://")
                .trim_start_matches("http://");
            let who = format!("{} ({}, responses)", self.provider_label, host);
            let label = if let Some(msg) = api_message {
                format!("{} error {} — {}\nFull response: {}", who, status, msg, raw)
            } else {
                format!("{} error {} — {}", who, status, raw)
            };
            let _ = tx.send(ProviderEvent::Error(label)).await;
            return Ok(rx);
        }

        let mut stream = resp.bytes_stream();

        tokio::spawn(async move {
            let mut buffer = String::new();
            // item_id → call_id, so streamed argument deltas (keyed by item_id)
            // resolve to the call_id we must echo back as function_call_output.
            let mut item_to_call: std::collections::HashMap<String, String> = std::collections::HashMap::new();
            let mut active_calls: Vec<String> = Vec::new();
            let mut saw_tool_call = false;

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
                        let lt = line.trim();
                        if lt.is_empty() || lt == "data: [DONE]" {
                            continue;
                        }
                        // Responses SSE also emits `event:` lines; ignore them and
                        // key off the `type` field inside the JSON `data:` payload.
                        let Some(data) = lt.strip_prefix("data:") else { continue };
                        let d = data.trim();
                        if d.is_empty() {
                            continue;
                        }
                        let Ok(val) = serde_json::from_str::<serde_json::Value>(d) else { continue };
                        match val["type"].as_str().unwrap_or("") {
                            "response.output_text.delta" => {
                                if let Some(delta) = val["delta"].as_str() {
                                    if !delta.is_empty() {
                                        let _ = tx.send(ProviderEvent::TextDelta(delta.to_string())).await;
                                    }
                                }
                            }
                            "response.reasoning_summary_text.delta" => {
                                if let Some(delta) = val["delta"].as_str() {
                                    if !delta.is_empty() {
                                        let id = val["item_id"].as_str().unwrap_or("reason").to_string();
                                        let _ = tx.send(ProviderEvent::ThinkingDelta { id, text: delta.to_string() }).await;
                                    }
                                }
                            }
                            "response.output_item.added" => {
                                let item = &val["item"];
                                if item["type"] == "function_call" {
                                    let item_id = item["id"].as_str().unwrap_or("").to_string();
                                    let call_id = item["call_id"].as_str().unwrap_or("").to_string();
                                    let name = item["name"].as_str().unwrap_or("").to_string();
                                    if !call_id.is_empty() {
                                        item_to_call.insert(item_id, call_id.clone());
                                        active_calls.push(call_id.clone());
                                        saw_tool_call = true;
                                        let _ = tx.send(ProviderEvent::ToolCallStart { id: call_id, name }).await;
                                    }
                                }
                            }
                            "response.function_call_arguments.delta" => {
                                let item_id = val["item_id"].as_str().unwrap_or("");
                                if let Some(call_id) = item_to_call.get(item_id) {
                                    if let Some(delta) = val["delta"].as_str() {
                                        let _ = tx.send(ProviderEvent::ToolCallDelta {
                                            id: call_id.clone(),
                                            json_fragment: delta.to_string(),
                                        }).await;
                                    }
                                }
                            }
                            "response.completed" => {
                                let usage = &val["response"]["usage"];
                                let it = usage["input_tokens"].as_u64().unwrap_or(0);
                                let ot = usage["output_tokens"].as_u64().unwrap_or(0);
                                if it > 0 || ot > 0 {
                                    let _ = tx.send(ProviderEvent::Usage { input_tokens: it, output_tokens: ot }).await;
                                }
                            }
                            "response.failed" => {
                                let msg = val["response"]["error"]["message"]
                                    .as_str()
                                    .unwrap_or("response failed")
                                    .to_string();
                                let _ = tx.send(ProviderEvent::Error(msg)).await;
                            }
                            "error" => {
                                let msg = val["message"].as_str().unwrap_or("stream error").to_string();
                                let _ = tx.send(ProviderEvent::Error(msg)).await;
                            }
                            _ => {}
                        }
                    }
                }
            }

            for id in active_calls {
                let _ = tx.send(ProviderEvent::ToolCallEnd { id }).await;
            }
            let stop = if saw_tool_call { "tool_use" } else { "end_turn" };
            let _ = tx.send(ProviderEvent::MessageStop { stop_reason: stop.to_string() }).await;
        });

        Ok(rx)
    }
}

/// Models served ONLY by /v1/responses (they 404 on /v1/chat/completions):
/// the codex, -pro, and deep-research variants. Base chat models and the
/// standard reasoning models (o1/o3/o4-mini) support both, so they stay on
/// chat/completions.
fn needs_responses_api(model: &str) -> bool {
    // Single source of truth: crate::models.
    crate::models::needs_responses_api(model)
}

/// Translate internal Anthropic-style message blocks into /v1/responses
/// `input` items: user/assistant text stay as role messages; `tool_use`
/// becomes a `function_call` item and `tool_result` a `function_call_output`,
/// correlated by call_id (the same id we assigned at ToolCallStart).
fn build_responses_input(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for msg in messages {
        let role = msg["role"].as_str().unwrap_or("user");
        if msg["content"].is_string() {
            out.push(serde_json::json!({ "role": role, "content": msg["content"].as_str().unwrap_or("") }));
        } else if let Some(arr) = msg["content"].as_array() {
            if role == "user" {
                for block in arr {
                    match block["type"].as_str() {
                        Some("tool_result") => {
                            let call_id = block["tool_use_id"].as_str().unwrap_or("");
                            let content_val = &block["content"];
                            let output = if content_val.is_string() {
                                content_val.as_str().unwrap_or("").to_string()
                            } else {
                                content_val.to_string()
                            };
                            out.push(serde_json::json!({
                                "type": "function_call_output",
                                "call_id": call_id,
                                "output": output,
                            }));
                        }
                        Some("text") => {
                            out.push(serde_json::json!({ "role": "user", "content": block["text"].as_str().unwrap_or("") }));
                        }
                        _ => {}
                    }
                }
            } else if role == "assistant" {
                let mut text_content = String::new();
                let mut calls = Vec::new();
                for block in arr {
                    match block["type"].as_str() {
                        Some("text") => {
                            if let Some(t) = block["text"].as_str() {
                                text_content.push_str(t);
                            }
                        }
                        Some("tool_use") => {
                            let id = block["id"].as_str().unwrap_or("");
                            let name = block["name"].as_str().unwrap_or("");
                            calls.push(serde_json::json!({
                                "type": "function_call",
                                "call_id": id,
                                "name": name,
                                "arguments": block["input"].to_string(),
                            }));
                        }
                        _ => {}
                    }
                }
                if !text_content.is_empty() {
                    out.push(serde_json::json!({ "role": "assistant", "content": text_content }));
                }
                out.extend(calls);
            }
        }
    }
    out
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
