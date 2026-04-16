use futures::StreamExt;
use tokio::sync::mpsc;

use super::types::{GhostConfig, ProviderEvent, ToolDef};

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
