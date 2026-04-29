use serde_json::Value;
use tracing::{info, warn};

const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
const DEFAULT_MODEL: &str = "gemma4:e2b";
const DEFAULT_KEEP_RECENT: usize = 6;
const COMPRESS_THRESHOLD: usize = 10;
const FOCUS_MIN_CHARS: usize = 400;

pub struct ContextCompressor {
    client: reqwest::Client,
    pub ollama_url: String,
    pub model: String,
    keep_recent: usize,
}

impl ContextCompressor {
    pub fn new(ollama_url: &str, model: &str) -> Self {
        ContextCompressor {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
            ollama_url: ollama_url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            keep_recent: DEFAULT_KEEP_RECENT,
        }
    }

    pub fn from_env() -> Self {
        let url = std::env::var("OLLAMA_HOST").unwrap_or_else(|_| DEFAULT_OLLAMA_URL.to_string());
        let model = std::env::var("MAXIMUS_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
        Self::new(&url, &model)
    }

    pub async fn is_available(&self) -> bool {
        let tags_url = format!("{}/api/tags", self.ollama_url);
        let resp = match self.client.get(&tags_url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => return false,
        };

        let json: Value = match resp.json().await {
            Ok(j) => j,
            Err(_) => return false,
        };

        let model_present = json["models"]
            .as_array()
            .map(|models| {
                models.iter().any(|m| {
                    m["name"]
                        .as_str()
                        .map(|n| n == self.model || n.starts_with(&format!("{}:", self.model)))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);

        if !model_present {
            info!("maximus: model '{}' not found — pulling in background", self.model);
            let client = self.client.clone();
            let url = format!("{}/api/pull", self.ollama_url);
            let model = self.model.clone();
            tokio::spawn(async move {
                let body = serde_json::json!({"name": model, "stream": false});
                match client.post(&url).json(&body).send().await {
                    Ok(r) if r.status().is_success() => {
                        tracing::info!("maximus: model '{}' pull complete", model)
                    }
                    Ok(r) => tracing::warn!("maximus: model pull returned HTTP {}", r.status()),
                    Err(e) => tracing::warn!("maximus: model pull failed: {}", e),
                }
            });
            return false;
        }

        true
    }

    pub async fn compress_messages(&self, messages: &[Value]) -> Vec<Value> {
        if messages.len() <= COMPRESS_THRESHOLD {
            return messages.to_vec();
        }

        let split_at = messages.len().saturating_sub(self.keep_recent);
        let older = &messages[..split_at];
        let recent = &messages[split_at..];

        match self.summarize(older).await {
            Ok(summary) => {
                info!(
                    "maximus: compressed {} messages → summary + {} recent",
                    older.len(),
                    recent.len()
                );
                let mut out = Vec::with_capacity(recent.len() + 2);
                out.push(serde_json::json!({
                    "role": "user",
                    "content": format!("[Earlier context — compressed]\n{}", summary)
                }));
                out.push(serde_json::json!({
                    "role": "assistant",
                    "content": "Context noted."
                }));
                out.extend_from_slice(recent);
                out
            }
            Err(e) => {
                warn!("maximus: compression skipped ({}), using full history", e);
                messages.to_vec()
            }
        }
    }

    pub async fn extract_focused(&self, content: &str, focus: &str) -> String {
        if content.len() < FOCUS_MIN_CHARS || focus.trim().is_empty() {
            return content.to_string();
        }
        match self.do_focus_extract(content, focus).await {
            Ok(extracted) => {
                info!(
                    "maximus: focus extract {} chars → {} chars (focus: {:?})",
                    content.len(),
                    extracted.len(),
                    &focus[..focus.len().min(60)]
                );
                extracted
            }
            Err(e) => {
                warn!("maximus: focus extract failed ({}), returning full content", e);
                content.to_string()
            }
        }
    }

    async fn do_focus_extract(&self, content: &str, focus: &str) -> anyhow::Result<String> {
        let body = serde_json::json!({
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a precision extractor. Given tool output and a focus request, \
                        return ONLY the information relevant to the focus. Be concise and direct. \
                        If the focus is not present in the output, say so in one sentence. \
                        Do not add commentary."
                },
                {
                    "role": "user",
                    "content": format!("Focus: {}\n\nOutput:\n{}", focus, content)
                }
            ],
            "stream": false
        });

        let resp = self
            .client
            .post(format!("{}/api/chat", self.ollama_url))
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            anyhow::bail!("Ollama returned HTTP {}", resp.status());
        }

        let json: Value = resp.json().await?;
        json["message"]["content"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("no content field in Ollama response"))
    }

    async fn summarize(&self, messages: &[Value]) -> anyhow::Result<String> {
        let text = render_messages(messages);

        let body = serde_json::json!({
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a context compressor for an AI agent conversation log. \
                        Summarize the following messages concisely. \
                        Preserve: tool names called, key results, decisions made, errors encountered, \
                        and any state the agent has established. \
                        Omit: pleasantries, verbose reasoning, repeated content. \
                        Be dense and precise. Output plain text only."
                },
                {
                    "role": "user",
                    "content": text
                }
            ],
            "stream": false
        });

        let resp = self
            .client
            .post(format!("{}/api/chat", self.ollama_url))
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            anyhow::bail!("Ollama returned HTTP {}", resp.status());
        }

        let json: Value = resp.json().await?;
        json["message"]["content"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("no content field in Ollama response"))
    }
}

fn render_messages(messages: &[Value]) -> String {
    messages
        .iter()
        .map(|m| {
            let role = m["role"].as_str().unwrap_or("?");
            let content = extract_content(&m["content"]);
            format!("{}: {}", role, content)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn extract_content(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| match p["type"].as_str() {
                Some("text") => p["text"].as_str().map(str::to_string),
                Some("tool_use") => Some(format!(
                    "[tool_use: {} input={}]",
                    p["name"].as_str().unwrap_or("?"),
                    p["input"]
                )),
                Some("tool_result") => {
                    let content = p["content"]
                        .as_str()
                        .or_else(|| p["content"][0]["text"].as_str())
                        .unwrap_or("…");
                    Some(format!("[tool_result: {}]", &content[..content.len().min(200)]))
                }
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" "),
        other => other.to_string(),
    }
}
