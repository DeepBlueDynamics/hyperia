//! Ferricula memory backend — pure HTTP client.
//!
//! Hyperia talks to Ferricula over HTTP. Run Ferricula locally in Docker
//! (`docker compose up ferricula`) or point at a remote URL.
//!
//! Config in ~/.hyperia/hyperia.json under config.ferricula:
//!   { "url": "http://localhost:8765" }
//! Or set the FERRICULA_URL env var. Defaults to http://localhost:8765.
//!
//! If Ferricula is unreachable, all calls degrade gracefully (recall returns
//! empty, remember is best-effort). The sidecar never blocks waiting for it.

/// Memory backend that the Ghost agent uses. Pure HTTP client to Ferricula.
pub struct FerriculaBackend {
    url: String,
    client: reqwest::Client,
}

#[derive(Debug, Clone)]
pub struct FerriculaConfig {
    pub url: String,
}

impl FerriculaBackend {
    pub fn new(config: &FerriculaConfig) -> Self {
        Self {
            url: config.url.clone(),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
        }
    }

    /// Recall memories relevant to a query. Filters out ghost-history rows
    /// (those are for chat transcript restoration, not semantic recall).
    pub async fn recall(&self, query: &str) -> String {
        let body = serde_json::json!({ "query": query });
        let resp = match self
            .client
            .post(format!("{}/recall", self.url))
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => return String::new(),
        };
        let text = match resp.text().await {
            Ok(t) => t,
            Err(_) => return String::new(),
        };
        let json: serde_json::Value = match serde_json::from_str(&text) {
            Ok(j) => j,
            Err(_) => return String::new(),
        };

        let mut results: Vec<String> = Vec::new();
        Self::extract_recall_texts_filtered(&json, &mut results);
        if results.is_empty() {
            return String::new();
        }
        let formatted: Vec<String> = results
            .iter()
            .take(8)
            .map(|t| format!("- {}", t))
            .collect();
        format!("\n## Recalled memories\n{}", formatted.join("\n"))
    }

    /// Store a memory with full control over metadata.
    pub async fn remember_full(
        &self,
        text: &str,
        channel: &str,
        importance: f32,
        emotion: Option<(&str, Option<&str>)>,
        keystone: bool,
    ) {
        let max_id = match self.remote_max_id().await {
            Ok(id) => id,
            Err(_) => return,
        };

        let mut tags = serde_json::Map::new();
        tags.insert("text".into(), serde_json::Value::String(text.to_string()));
        tags.insert("channel".into(), serde_json::Value::String(channel.to_string()));
        tags.insert("source".into(), serde_json::Value::String("hyperia-ghost".into()));

        let mut body = serde_json::json!({
            "id": max_id + 1,
            "tags": tags,
            "vector": vec![0.0f32; 768],
            "importance": importance,
            "keystone": keystone,
        });
        if let Some((primary, secondary)) = emotion {
            body["emotion"] = serde_json::json!({
                "primary": primary,
                "secondary": secondary,
            });
        }
        let _ = self
            .client
            .post(format!("{}/remember", self.url))
            .json(&body)
            .send()
            .await;
    }

    /// Simple remember — convenience wrapper.
    pub async fn remember(&self, text: &str, channel: &str) {
        self.remember_full(text, channel, 0.5, None, false).await;
    }

    /// Store a chat turn for history restoration. Tags with role.
    pub async fn remember_turn(&self, role: &str, content: &str) {
        let text = if content.len() > 1000 {
            &content[..1000]
        } else {
            content
        };
        let max_id = match self.remote_max_id().await {
            Ok(id) => id,
            Err(_) => return,
        };
        let body = serde_json::json!({
            "id": max_id + 1,
            "tags": {
                "text": text,
                "role": role,
                "channel": "ghost-history",
                "source": "hyperia-ghost",
            },
            "vector": vec![0.0f32; 768],
            "importance": 0.3,
            "keystone": false,
        });
        let _ = self
            .client
            .post(format!("{}/remember", self.url))
            .json(&body)
            .send()
            .await;
    }

    /// Trigger a dream cycle — memory consolidation on the ferricula server.
    pub async fn dream(&self) -> String {
        let body = serde_json::json!({});
        match self
            .client
            .post(format!("{}/dream", self.url))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => match resp.text().await {
                Ok(t) => t,
                Err(e) => format!("Dream response read failed: {}", e),
            },
            Err(e) => format!("Dream request failed: {}", e),
        }
    }

    /// Connect two memories with a semantic edge.
    pub async fn connect(&self, id_a: u32, id_b: u32, label: &str) -> String {
        let body = serde_json::json!({
            "a": id_a,
            "b": id_b,
            "label": label,
            "weight": 1.0,
            "kind": "semantic",
        });
        match self
            .client
            .post(format!("{}/connect", self.url))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => match resp.text().await {
                Ok(_) => format!("Connected {} <-> {} ({})", id_a, id_b, label),
                Err(e) => format!("Connect response read failed: {}", e),
            },
            Err(e) => format!("Connect failed: {}", e),
        }
    }

    /// Retrieve all text entries stored in a named channel.
    ///
    /// TODO: ferricula has no list-by-channel endpoint. Until one exists,
    /// this returns empty — callers fall back to cold-start behavior (e.g.
    /// Maximus re-learns patterns on first encounter of each content type).
    /// Tracked: see related issue for adding /list?channel=X.
    pub async fn list_channel(&self, _channel: &str) -> Vec<String> {
        Vec::new()
    }

    /// Retrieve recent ghost chat history for UI restoration.
    pub async fn history(&self, limit: usize) -> Vec<(String, String)> {
        let mut turns = Vec::new();
        let max_id = match self.remote_max_id().await {
            Ok(id) => id,
            Err(_) => return turns,
        };
        let start = if max_id > 200 { max_id - 200 } else { 1 };
        for id in (start..=max_id).rev() {
            if turns.len() >= limit {
                break;
            }
            if let Ok(resp) = self.client.get(format!("{}/get/{}", self.url, id)).send().await {
                if let Ok(text) = resp.text().await {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        let result = Self::parse_result(&json);
                        if result["tags"]["channel"].as_str() == Some("ghost-history") {
                            let role = result["tags"]["role"].as_str().unwrap_or("").to_string();
                            let content = result["tags"]["text"].as_str().unwrap_or("").to_string();
                            if !role.is_empty() && !content.is_empty() {
                                turns.push((role, content));
                            }
                        }
                    }
                }
            }
        }
        turns.reverse();
        turns
    }

    /// Get the identity state. Returns a stub synchronously; callers that want
    /// real identity should hit GET {url}/identity directly.
    pub fn identity_json(&self) -> serde_json::Value {
        serde_json::json!({
            "status": "identity served by ferricula at /identity",
            "url": self.url,
        })
    }

    /// Get config info — just the URL and reachability hint.
    pub fn config_json(&self) -> serde_json::Value {
        serde_json::json!({
            "url": self.url,
            "transport": "http",
        })
    }

    async fn remote_max_id(&self) -> Result<u32, ()> {
        match self.client.get(format!("{}/maxid", self.url)).send().await {
            Ok(resp) => {
                let body = resp.text().await.map_err(|_| ())?;
                let json: serde_json::Value = serde_json::from_str(&body).map_err(|_| ())?;
                let result = Self::parse_result(&json);
                result
                    .as_u64()
                    .map(|n| n as u32)
                    .or_else(|| result["max_id"].as_u64().map(|n| n as u32))
                    .ok_or(())
            }
            Err(_) => Err(()),
        }
    }

    fn parse_result(json: &serde_json::Value) -> serde_json::Value {
        let result = &json["result"];
        if let Some(s) = result.as_str() {
            serde_json::from_str(s).unwrap_or_default()
        } else {
            result.clone()
        }
    }

    /// Extract recall texts from the API response, filtering ghost-history rows.
    fn extract_recall_texts_filtered(json: &serde_json::Value, results: &mut Vec<String>) {
        let result = Self::parse_result(json);
        let rows = result
            .as_array()
            .or_else(|| result["rows"].as_array())
            .or_else(|| result["results"].as_array());
        if let Some(rows) = rows {
            for row in rows.iter().take(10) {
                let channel = row["tags"]["channel"]
                    .as_str()
                    .or_else(|| row["channel"].as_str())
                    .unwrap_or("");
                if channel == "ghost-history" {
                    continue;
                }
                if let Some(text) = row["tags"]["text"].as_str().or(row["text"].as_str()) {
                    if !text.is_empty() {
                        results.push(text.to_string());
                    }
                }
            }
        }
    }
}

/// Load ferricula config. Resolution order:
///   1. FERRICULA_URL env var
///   2. ~/.hyperia/hyperia.json → config.ferricula.url
///   3. Default http://localhost:8765
pub fn load_ferricula_config() -> FerriculaConfig {
    if let Ok(url) = std::env::var("FERRICULA_URL") {
        let url = url.trim().trim_end_matches('/').to_string();
        if !url.is_empty() {
            return FerriculaConfig { url };
        }
    }

    let cfg_path = {
        let home = if cfg!(windows) {
            std::env::var("USERPROFILE").unwrap_or_default()
        } else {
            std::env::var("HOME").unwrap_or_default()
        };
        std::path::PathBuf::from(home).join(".hyperia").join("hyperia.json")
    };

    if let Ok(content) = std::fs::read_to_string(&cfg_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            let fc = &json["config"]["ferricula"];
            return FerriculaConfig {
                url: fc["url"]
                    .as_str()
                    .unwrap_or("http://localhost:8765")
                    .trim_end_matches('/')
                    .to_string(),
            };
        }
    }

    FerriculaConfig {
        url: "http://localhost:8765".into(),
    }
}
