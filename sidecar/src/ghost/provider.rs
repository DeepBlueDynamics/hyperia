use futures::StreamExt;
use tokio::sync::mpsc;

use super::types::{GhostConfig, ProviderEvent, ToolDef};

// ---------------------------------------------------------------------------
// AnyProvider — dispatch enum wrapping all supported backends
// ---------------------------------------------------------------------------

pub enum AnyProvider {
    Anthropic(AnthropicProvider),
    Ollama(OllamaProvider),
}

impl AnyProvider {
    pub fn from_config(config: &GhostConfig) -> Self {
        if config.model.starts_with("ollama:") {
            AnyProvider::Ollama(OllamaProvider::new(config))
        } else {
            AnyProvider::Anthropic(AnthropicProvider::new(config))
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
}

impl AnthropicProvider {
    pub fn new(config: &GhostConfig) -> Self {
        let model = match config.model.as_str() {
            // Legacy provider key — default to Haiku 4.5
            "anthropic" => "claude-haiku-4-5-20251001".to_string(),
            // Full model IDs passed through directly
            other => other.to_string(),
        };
        Self {
            client: reqwest::Client::new(),
            api_key: config.api_key.clone(),
            model,
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
                .post("https://api.anthropic.com/v1/messages")
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

pub struct OllamaProvider {
    client: reqwest::Client,
    model: String,
}

impl OllamaProvider {
    pub fn new(config: &GhostConfig) -> Self {
        // Strip the "ollama:" prefix to get the actual model tag
        let model = config
            .model
            .strip_prefix("ollama:")
            .unwrap_or(&config.model)
            .to_string();
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            model,
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

    /// Convert internal ToolDef list into Ollama tool format.
    fn build_ollama_tools(tools: &[ToolDef]) -> Vec<serde_json::Value> {
        tools
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
            .collect()
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
        let ollama_tools = Self::build_ollama_tools(tools);

        let mut body = serde_json::json!({
            "model": self.model,
            "messages": ollama_messages,
            "stream": true,
        });

        // Only include tools if there are any — some models choke on empty tools array
        if !ollama_tools.is_empty() {
            body["tools"] = serde_json::json!(ollama_tools);
        }

        let resp = self
            .client
            .post("http://localhost:11434/api/chat")
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await;

        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                let msg = if e.is_connect() {
                    format!(
                        "Ollama not running. Start Ollama and pull {} with: ollama pull {}",
                        self.model, self.model
                    )
                } else {
                    format!("Ollama connection error: {}", e)
                };
                let _ = tx.send(ProviderEvent::Error(msg)).await;
                return Ok(rx);
            }
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let raw = resp.text().await.unwrap_or_default();
            let label = format!("Ollama API error {} — {}", status, raw);
            let _ = tx.send(ProviderEvent::Error(label)).await;
            return Ok(rx);
        }

        let mut stream = resp.bytes_stream();
        let model_name = self.model.clone();

        tokio::spawn(async move {
            let mut buffer = String::new();
            let mut had_tool_calls = false;
            let mut tool_counter: usize = 0;

            while let Some(chunk) = stream.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(ProviderEvent::Error(e.to_string())).await;
                        break;
                    }
                };

                buffer.push_str(&String::from_utf8_lossy(&chunk));

                // NDJSON: each line is a complete JSON object
                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();

                    if line.is_empty() {
                        continue;
                    }

                    let json: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(j) => j,
                        Err(_) => continue,
                    };

                    // Check for the final "done" message
                    if json["done"].as_bool() == Some(true) {
                        // Emit usage from the final summary
                        let input_tokens =
                            json["prompt_eval_count"].as_u64().unwrap_or(0);
                        let output_tokens =
                            json["eval_count"].as_u64().unwrap_or(0);
                        if input_tokens > 0 || output_tokens > 0 {
                            let _ = tx
                                .send(ProviderEvent::Usage {
                                    input_tokens,
                                    output_tokens,
                                })
                                .await;
                        }

                        let stop_reason = if had_tool_calls {
                            "tool_use".to_string()
                        } else {
                            "end_turn".to_string()
                        };
                        let _ = tx
                            .send(ProviderEvent::MessageStop { stop_reason })
                            .await;
                        continue;
                    }

                    let message = &json["message"];

                    // Text content
                    if let Some(text) = message["content"].as_str() {
                        if !text.is_empty() {
                            let _ =
                                tx.send(ProviderEvent::TextDelta(text.to_string())).await;
                        }
                    }

                    // Tool calls
                    if let Some(tool_calls) = message["tool_calls"].as_array() {
                        for tc in tool_calls {
                            let func = &tc["function"];
                            let name = func["name"]
                                .as_str()
                                .unwrap_or("unknown")
                                .to_string();
                            let arguments = &func["arguments"];
                            let id = format!("ol_{}", tool_counter);
                            tool_counter += 1;
                            had_tool_calls = true;

                            let _ = tx
                                .send(ProviderEvent::ToolCallStart {
                                    id: id.clone(),
                                    name,
                                })
                                .await;

                            // Emit the full arguments as a single delta
                            let args_str = arguments.to_string();
                            let _ = tx
                                .send(ProviderEvent::ToolCallDelta {
                                    id: id.clone(),
                                    json_fragment: args_str,
                                })
                                .await;

                            let _ =
                                tx.send(ProviderEvent::ToolCallEnd { id }).await;
                        }
                    }
                }
            }

            // Handle any remaining data in buffer (no trailing newline)
            let remaining = buffer.trim().to_string();
            if !remaining.is_empty() {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&remaining) {
                    if json["done"].as_bool() == Some(true) {
                        let input_tokens =
                            json["prompt_eval_count"].as_u64().unwrap_or(0);
                        let output_tokens =
                            json["eval_count"].as_u64().unwrap_or(0);
                        if input_tokens > 0 || output_tokens > 0 {
                            let _ = tx
                                .send(ProviderEvent::Usage {
                                    input_tokens,
                                    output_tokens,
                                })
                                .await;
                        }
                        let stop_reason = if had_tool_calls {
                            "tool_use".to_string()
                        } else {
                            "end_turn".to_string()
                        };
                        let _ = tx
                            .send(ProviderEvent::MessageStop { stop_reason })
                            .await;
                    } else if let Some(text) = json["message"]["content"].as_str() {
                        if !text.is_empty() {
                            let _ =
                                tx.send(ProviderEvent::TextDelta(text.to_string())).await;
                        }
                    }
                }
            }

            // Safety: if we never got a done=true, emit a stop anyway
            // (the channel will just drop if we already sent one)
            let _ = tx
                .send(ProviderEvent::MessageStop {
                    stop_reason: if had_tool_calls {
                        "tool_use".to_string()
                    } else {
                        "end_turn".to_string()
                    },
                })
                .await;
        });

        Ok(rx)
    }
}
