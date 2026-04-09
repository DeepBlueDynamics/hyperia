//! Ferricula memory backend — local embedded with full identity, or remote HTTP, or both.
//!
//! Config in ~/.hyperia/hyperia.json under config.ferricula:
//!   { "mode": "local" | "remote" | "both", "url": "http://..." }

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use ferricula::identity::IdentityState;
use ferricula::memory::{Emotion, MemoryRecord};

/// Full Ferricula core — engine + identity + search.
pub struct FerriculaCore {
    pub engine: Mutex<ferricula::DurableEngine>,
    pub identity: Mutex<IdentityState>,
    pub search: Mutex<ferricula::SearchEngine>,
}

/// Memory backend that the Ghost agent uses.
pub struct FerriculaBackend {
    local: Option<Arc<FerriculaCore>>,
    remote_url: Option<String>,
    remote_client: reqwest::Client,
    shivvr_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FerriculaConfig {
    pub mode: String,
    pub url: String,
    pub shivvr_url: Option<String>,
}

impl FerriculaBackend {
    pub fn new(config: &FerriculaConfig) -> Self {
        let local = if config.mode == "local" || config.mode == "both" {
            let data_dir = Self::data_dir();
            let dir_str = data_dir.to_string_lossy().to_string();
            let _ = std::fs::create_dir_all(&data_dir);

            match ferricula::DurableEngine::open(&dir_str) {
                Ok(mut engine) => {
                    // Load or create identity — the blessing
                    let entropy = get_entropy();
                    let (identity, is_new) = ferricula::identity::load_or_create(&dir_str, &entropy);

                    if is_new {
                        tracing::info!("Ferricula blessed: {} ({})", identity.agent_id, identity.name);
                        tracing::info!("  Hexagram {}: {}", identity.hexagram.number, identity.hexagram.name);
                        tracing::info!("  {}/{}", identity.primary_emotion, identity.secondary_emotion);
                        tracing::info!("  Sign: {}", identity.horoscope.sign_name);

                        // Create the identity anchor memory
                        let (row, record) = ferricula::identity::create_anchor(&identity);
                        if let Err(e) = engine.remember(row, record) {
                            tracing::warn!("Identity anchor skipped (dim mismatch ok): {}", e);
                        }
                    } else {
                        tracing::info!("Ferricula identity loaded: {} ({})", identity.agent_id, identity.name);
                    }

                    // Build search engine from existing memories
                    let mut search = ferricula::SearchEngine::new();
                    let bitmap = engine.engine().all_bitmap();
                    for id in bitmap.iter() {
                        if let Some(row) = engine.engine().get(id) {
                            if let Some(text) = row.tags.get("text") {
                                search.add_document(id, text);
                            }
                        }
                    }
                    tracing::info!("Ferricula search index: {} docs", bitmap.len());

                    Some(Arc::new(FerriculaCore {
                        engine: Mutex::new(engine),
                        identity: Mutex::new(identity),
                        search: Mutex::new(search),
                    }))
                }
                Err(e) => {
                    tracing::warn!("Failed to open Ferricula engine: {}", e);
                    None
                }
            }
        } else {
            None
        };

        let remote_url = if config.mode == "remote" || config.mode == "both" {
            Some(config.url.clone())
        } else {
            None
        };

        Self {
            local,
            remote_url,
            remote_client: reqwest::Client::new(),
            shivvr_url: config.shivvr_url.clone(),
        }
    }

    fn data_dir() -> std::path::PathBuf {
        let home = if cfg!(windows) {
            std::env::var("USERPROFILE").unwrap_or_default()
        } else {
            std::env::var("HOME").unwrap_or_default()
        };
        std::path::PathBuf::from(home).join(".hyperia").join("memory")
    }

    /// Generate embeddings for text using Shivvr server.
    async fn embed(&self, text: &str) -> Vec<f32> {
        if let Some(ref url) = self.shivvr_url {
            let body = serde_json::json!({ "text": text });
            if let Ok(resp) = self.remote_client.post(format!("{}/embed", url)).json(&body).send().await {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if let Some(vec) = json["embedding"].as_array() {
                        let embedding: Vec<f32> = vec.iter()
                            .filter_map(|v| v.as_f64().map(|f| f as f32))
                            .collect();
                        if embedding.len() == 768 {
                            return embedding;
                        }
                    }
                }
            }
        }
        // Fallback: zeros
        vec![0.0; 768]
    }

    /// Recall memories relevant to a query: BM25 (real scores) + vector + keyword backfill.
    /// Boosts by importance/keystone, deduplicates by ID, filters ghost-history throughout.
    pub async fn recall(&self, query: &str) -> String {
        // Primary store: id → (score, text). Dedup by ID before ranking.
        let mut by_id: std::collections::HashMap<u32, (f32, String)> = Default::default();
        // Seen texts for remote dedup (no IDs available from remote).
        let mut seen_texts: std::collections::HashSet<String> = Default::default();

        // Query embedding for semantic search — requires Shivvr to be configured.
        let query_vec = self.embed(query).await;
        let has_embeddings = query_vec.iter().any(|&v| v != 0.0);
        if !has_embeddings && self.shivvr_url.is_some() {
            tracing::warn!("Ferricula recall: Shivvr embedding failed — falling back to BM25+keyword only");
        }

        if let Some(ref core) = self.local {
            let db = core.engine.lock().unwrap();
            let search = core.search.lock().unwrap();

            // --- Stage 1: BM25 with real scores, normalized to [0,1] ---
            let hits = search.bm25_search(query, 25, db.prime_tree());
            let max_bm25 = hits.iter().map(|h| h.bm25_score).fold(0.0f64, f64::max);
            for hit in &hits {
                if let Some(row) = db.engine().get(hit.id) {
                    if row.tags.get("channel").map(|s| s.as_str()) == Some("ghost-history") { continue; }
                    if let Some(text) = row.tags.get("text") {
                        let base = if max_bm25 > 0.0 { (hit.bm25_score / max_bm25) as f32 } else { 0.5 };
                        let score = importance_boost(base, db.memory_store().get(hit.id));
                        by_id.insert(hit.id, (score, text.clone()));
                        seen_texts.insert(text.clone());
                    }
                }
            }

            // --- Stage 2: Vector similarity — scan ALL rows, no cap ---
            if has_embeddings {
                let bitmap = db.engine().all_bitmap();
                for id in bitmap.iter() {
                    if by_id.contains_key(&id) { continue; }
                    if let Some(row) = db.engine().get(id) {
                        if row.tags.get("channel").map(|s| s.as_str()) == Some("ghost-history") { continue; }
                        if row.vector.iter().all(|&v| v == 0.0) { continue; }
                        let sim = cosine_similarity(&query_vec, &row.vector);
                        if sim > 0.45 {
                            if let Some(text) = row.tags.get("text") {
                                let score = importance_boost(sim, db.memory_store().get(id));
                                by_id.insert(id, (score, text.clone()));
                                seen_texts.insert(text.clone());
                            }
                        }
                    }
                }
            }

            // --- Stage 3: Keyword backfill — always runs, fills gaps not covered above ---
            let terms: Vec<String> = query.split_whitespace()
                .map(|s| s.to_lowercase()).take(5).collect();
            if !terms.is_empty() {
                let bitmap = db.engine().all_bitmap();
                let mut backfill = 0usize;
                for id in bitmap.iter() {
                    if backfill >= 10 { break; }
                    if by_id.contains_key(&id) { continue; }
                    if let Some(row) = db.engine().get(id) {
                        if row.tags.get("channel").map(|s| s.as_str()) == Some("ghost-history") { continue; }
                        if let Some(text) = row.tags.get("text") {
                            let lower = text.to_lowercase();
                            if terms.iter().any(|t| lower.contains(t)) {
                                let score = importance_boost(0.1, db.memory_store().get(id));
                                by_id.insert(id, (score, text.clone()));
                                seen_texts.insert(text.clone());
                                backfill += 1;
                            }
                        }
                    }
                }
            }
        }

        let mut scored: Vec<(f32, String)> = by_id.into_values().collect();

        // --- Remote recall: filter ghost-history, dedup against local results ---
        if let Some(ref url) = self.remote_url {
            let body = serde_json::json!({ "query": query });
            if let Ok(resp) = self.remote_client.post(format!("{}/recall", url)).json(&body).send().await {
                if let Ok(text) = resp.text().await {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        let mut remote: Vec<String> = Vec::new();
                        Self::extract_recall_texts_filtered(&json, &mut remote);
                        for r in remote {
                            if !seen_texts.contains(&r) {
                                scored.push((0.5, r));
                            }
                        }
                    }
                }
            }
        }

        if scored.is_empty() {
            return String::new();
        }

        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let formatted: Vec<String> = scored.iter().take(8).map(|(_, t)| format!("- {}", t)).collect();
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
        // Generate embedding
        let vector = self.embed(text).await;

        if let Some(ref core) = self.local {
            let mut db = core.engine.lock().unwrap();
            let mut search = core.search.lock().unwrap();
            let next_id = db.engine().all_bitmap().max().unwrap_or(0) + 1;

            let mut tags = BTreeMap::new();
            tags.insert("text".into(), text.to_string());
            tags.insert("channel".into(), channel.to_string());
            tags.insert("source".into(), "hyperia-ghost".to_string());

            let row = ferricula::Row {
                id: next_id,
                tags,
                vector,
            };

            let mut record = MemoryRecord::new(next_id);
            record.importance = importance;
            record.keystone = keystone;
            if let Some((primary, secondary)) = emotion {
                record.emotion = Some(Emotion {
                    primary: primary.to_string(),
                    secondary: secondary.map(|s| s.to_string()),
                });
            }

            // Index for search
            search.add_document(next_id, text);

            let _ = db.remember(row, record);
        }

        // Remote
        if let Some(ref url) = self.remote_url {
            if let Ok(max_id) = self.remote_max_id(url).await {
                let body = serde_json::json!({
                    "id": max_id + 1,
                    "tags": { "text": text, "channel": channel, "source": "hyperia-ghost" },
                    "vector": vec![0.0f32; 768],
                    "importance": importance,
                    "keystone": keystone,
                });
                let _ = self.remote_client.post(format!("{}/remember", url)).json(&body).send().await;
            }
        }
    }

    /// Simple remember — convenience wrapper.
    pub async fn remember(&self, text: &str, channel: &str) {
        self.remember_full(text, channel, 0.5, None, false).await;
    }

    /// Store a chat turn for history restoration.
    pub async fn remember_turn(&self, role: &str, content: &str) {
        let text = if content.len() > 1000 { &content[..1000] } else { content };
        self.remember_full(text, "ghost-history", 0.3, None, false).await;
        // Tag with role
        if let Some(ref core) = self.local {
            // Generate embedding BEFORE acquiring locks
            let vector = self.embed(text).await;

            let db = core.engine.lock().unwrap();
            let bitmap = db.engine().all_bitmap();
            if let Some(max_id) = bitmap.max() {
                // The row we just inserted — update its tags to include role
                // (DurableEngine doesn't have a tag-update API, so we handle via upsert next time)
                drop(db);
                // For now, store role in a separate memory
                let mut db = core.engine.lock().unwrap();
                let mut search = core.search.lock().unwrap();
                let next_id = db.engine().all_bitmap().max().unwrap_or(0) + 1;
                let mut tags = BTreeMap::new();
                tags.insert("text".into(), text.to_string());
                tags.insert("role".into(), role.to_string());
                tags.insert("channel".into(), "ghost-history".to_string());
                tags.insert("source".into(), "hyperia-ghost".to_string());
                let row = ferricula::Row { id: next_id, tags, vector };
                let record = MemoryRecord::new(next_id);
                search.add_document(next_id, text);
                let _ = db.remember(row, record);
            }
        }
    }

    /// Trigger a dream cycle — memory consolidation.
    pub async fn dream(&self) -> String {
        if let Some(ref core) = self.local {
            let mut db = core.engine.lock().unwrap();
            let mut identity = core.identity.lock().unwrap();
            let report = db.dream(None);
            identity.activate_from_report(&report);
            // Save identity state
            let dir = Self::data_dir();
            let _ = std::fs::write(
                dir.join("identity.json"),
                identity.to_json(),
            );
            format!("Dream complete: {} ticks, {} consolidated, {} decayed, {} archived.\nActive archetypes: {:?}",
                report.ticks, report.consolidated, report.decayed, report.archived, report.active_archetypes)
        } else {
            "Ferricula not configured locally.".into()
        }
    }

    /// Connect two memories with a semantic edge.
    pub async fn connect(&self, id_a: u32, id_b: u32, label: &str) -> String {
        if let Some(ref core) = self.local {
            let mut db = core.engine.lock().unwrap();
            match db.connect(id_a, id_b, label.to_string(), 1.0, ferricula::EdgeKind::Semantic) {
                Ok(()) => format!("Connected {} <-> {} ({})", id_a, id_b, label),
                Err(e) => format!("Connect failed: {}", e),
            }
        } else {
            "Ferricula not configured locally.".into()
        }
    }

    /// Retrieve recent ghost chat history for UI restoration.
    pub async fn history(&self, limit: usize) -> Vec<(String, String)> {
        let mut turns = Vec::new();

        if let Some(ref core) = self.local {
            let db = core.engine.lock().unwrap();
            let bitmap = db.engine().all_bitmap();
            if let Some(max) = bitmap.max() {
                let start = if max > 200 { max - 200 } else { 0 };
                for id in (start..=max).rev() {
                    if turns.len() >= limit { break; }
                    if let Some(row) = db.engine().get(id) {
                        if row.tags.get("channel").map(|s| s.as_str()) == Some("ghost-history") {
                            let role = row.tags.get("role").cloned().unwrap_or_default();
                            let text = row.tags.get("text").cloned().unwrap_or_default();
                            if !role.is_empty() && !text.is_empty() {
                                turns.push((role, text));
                            }
                        }
                    }
                }
            }
        }

        if turns.is_empty() {
            if let Some(ref url) = self.remote_url {
                if let Ok(max_id) = self.remote_max_id(url).await {
                    let start = if max_id > 200 { max_id - 200 } else { 1 };
                    for id in (start..=max_id).rev() {
                        if turns.len() >= limit { break; }
                        if let Ok(resp) = self.remote_client.get(format!("{}/get/{}", url, id)).send().await {
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
                }
            }
        }

        turns.reverse();
        turns
    }

    /// Get the identity state.
    pub fn identity_json(&self) -> serde_json::Value {
        if let Some(ref core) = self.local {
            let identity = core.identity.lock().unwrap();
            serde_json::json!({
                "agent_id": identity.agent_id,
                "name": identity.name,
                "hexagram": {
                    "number": identity.hexagram.number,
                    "name": identity.hexagram.name,
                },
                "horoscope": identity.horoscope.sign_name,
                "primary_emotion": identity.primary_emotion,
                "secondary_emotion": identity.secondary_emotion,
                "cognitive_heat": identity.cognitive_heat,
                "archetypes": identity.archetypes.iter().map(|a| {
                    serde_json::json!({
                        "role": format!("{:?}", a.role),
                        "active": a.active,
                    })
                }).collect::<Vec<_>>(),
            })
        } else {
            serde_json::json!({"status": "no local core"})
        }
    }

    /// Get config info + identity.
    pub fn config_json(&self) -> serde_json::Value {
        let mode = if self.local.is_some() && self.remote_url.is_some() {
            "both"
        } else if self.remote_url.is_some() {
            "remote"
        } else {
            "local"
        };
        let mut info = serde_json::json!({
            "mode": mode,
            "url": self.remote_url.as_deref().unwrap_or(""),
            "local_data": Self::data_dir().to_string_lossy(),
            "local_active": self.local.is_some(),
            "remote_active": self.remote_url.is_some(),
        });
        if self.local.is_some() {
            info["identity"] = self.identity_json();
            if let Some(ref core) = self.local {
                let db = core.engine.lock().unwrap();
                info["memory_count"] = serde_json::json!(db.engine().row_count());
            }
        }
        info
    }

    async fn remote_max_id(&self, url: &str) -> Result<u32, ()> {
        match self.remote_client.get(format!("{}/maxid", url)).send().await {
            Ok(resp) => {
                let body = resp.text().await.map_err(|_| ())?;
                let json: serde_json::Value = serde_json::from_str(&body).map_err(|_| ())?;
                let result = Self::parse_result(&json);
                result.as_u64().map(|n| n as u32)
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

    /// Extract recall texts from remote API response, filtering ghost-history rows.
    fn extract_recall_texts_filtered(json: &serde_json::Value, results: &mut Vec<String>) {
        let result = Self::parse_result(json);
        let rows = result.as_array()
            .or_else(|| result["rows"].as_array())
            .or_else(|| result["results"].as_array());
        if let Some(rows) = rows {
            for row in rows.iter().take(10) {
                let channel = row["tags"]["channel"].as_str()
                    .or_else(|| row["channel"].as_str())
                    .unwrap_or("");
                if channel == "ghost-history" { continue; }
                if let Some(text) = row["tags"]["text"].as_str().or(row["text"].as_str()) {
                    if !text.is_empty() {
                        results.push(text.to_string());
                    }
                }
            }
        }
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() { return 0.0; }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 { return 0.0; }
    dot / (norm_a * norm_b)
}

/// Boost a base retrieval score using the memory record's importance and keystone flag.
/// importance is 0..1 (default 0.5); keystone adds a flat bonus.
fn importance_boost(base: f32, record: Option<&ferricula::memory::MemoryRecord>) -> f32 {
    let Some(rec) = record else { return base; };
    let factor = 0.5 + 0.5 * rec.importance.clamp(0.0, 1.0);
    let keystone_bonus = if rec.keystone { 0.15 } else { 0.0 };
    (base * factor + keystone_bonus).min(1.5)
}

fn get_entropy() -> Vec<u8> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut bytes = vec![0u8; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = ((now >> (i * 4)) & 0xFF) as u8;
    }
    // Mix in machine identity
    if let Ok(hostname) = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")) {
        for (i, b) in hostname.bytes().enumerate() {
            bytes[i % 32] ^= b;
        }
    }
    bytes
}

/// Load ferricula config from ~/.hyperia/hyperia.json.
pub fn load_ferricula_config() -> FerriculaConfig {
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
            let shivvr = &json["config"]["shivvr"];
            return FerriculaConfig {
                mode: fc["mode"].as_str().unwrap_or("local").to_string(),
                url: fc["url"].as_str().unwrap_or("http://localhost:8765").to_string(),
                shivvr_url: shivvr["url"].as_str().map(|s| s.to_string()),
            };
        }
    }

    FerriculaConfig {
        mode: "local".into(),
        url: "http://localhost:8765".into(),
        shivvr_url: None,
    }
}
