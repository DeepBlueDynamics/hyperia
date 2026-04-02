//! Ferricula memory client — recall before turns, remember after.

use reqwest::Client;

pub struct FerriculaClient {
    client: Client,
    base_url: String,
}

impl FerriculaClient {
    pub fn new() -> Option<Self> {
        let base_url = std::env::var("FERRICULA_URL")
            .unwrap_or_else(|_| "http://localhost:8765".into());

        Some(Self {
            client: Client::new(),
            base_url,
        })
    }

    /// Recall memories relevant to a query. Returns formatted text or empty string.
    pub async fn recall(&self, query: &str) -> String {
        let body = serde_json::json!({ "query": query });
        match self
            .client
            .post(format!("{}/recall", self.base_url))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                let text = resp.text().await.unwrap_or_default();
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                    format_recall_results(&json)
                } else {
                    String::new()
                }
            }
            Err(_) => String::new(), // Ferricula not available — degrade gracefully
        }
    }

    /// Store a memory after an exchange. Uses the search/text index (no vector needed).
    pub async fn remember(&self, text: &str, channel: &str) {
        // Get next available ID
        let next_id = match self
            .client
            .get(format!("{}/maxid", self.base_url))
            .send()
            .await
        {
            Ok(resp) => {
                let body = resp.text().await.unwrap_or_default();
                serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v["result"].as_u64().or(v["max_id"].as_u64()))
                    .unwrap_or(0) as u32
                    + 1
            }
            Err(_) => return, // Ferricula not available
        };

        // Create a zero vector (search engine will index by text)
        let zero_vec = vec![0.0f32; 64];

        let body = serde_json::json!({
            "id": next_id,
            "tags": {
                "text": text,
                "channel": channel,
                "source": "hyperia-ghost",
            },
            "vector": zero_vec,
            "importance": 0.5,
        });

        let _ = self
            .client
            .post(format!("{}/remember", self.base_url))
            .json(&body)
            .send()
            .await;
    }

    /// Check if Ferricula is reachable.
    pub async fn is_available(&self) -> bool {
        self.client
            .get(format!("{}/status", self.base_url))
            .send()
            .await
            .is_ok()
    }
}

fn format_recall_results(json: &serde_json::Value) -> String {
    // Try to extract recalled memories from the response
    let result = &json["result"];

    // Result might be a JSON string that needs parsing
    let parsed = if let Some(s) = result.as_str() {
        serde_json::from_str::<serde_json::Value>(s).unwrap_or_default()
    } else {
        result.clone()
    };

    // Look for rows/results array
    let rows = parsed
        .as_array()
        .or_else(|| parsed["rows"].as_array())
        .or_else(|| parsed["results"].as_array());

    let rows = match rows {
        Some(r) if !r.is_empty() => r,
        _ => return String::new(),
    };

    let mut memories = Vec::new();
    for row in rows.iter().take(5) {
        // Try to extract text from tags
        let text = row["tags"]["text"]
            .as_str()
            .or_else(|| row["text"].as_str())
            .unwrap_or("");
        if !text.is_empty() {
            memories.push(format!("- {}", text));
        }
    }

    if memories.is_empty() {
        String::new()
    } else {
        format!("\n## Recalled memories\n{}", memories.join("\n"))
    }
}
