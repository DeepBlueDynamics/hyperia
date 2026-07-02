use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{Mutex, RwLock};
use tracing::{info, warn};

use super::ferricula::FerriculaBackend;

const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
const DEFAULT_MODEL: &str = crate::models::COMPRESSOR_DEFAULT_MODEL;
const DEFAULT_KEEP_RECENT: usize = 6;
const COMPRESS_THRESHOLD: usize = 10;
pub const FOCUS_MIN_CHARS: usize = 400;
const MAX_ITERS: u8 = 3;
const STABILIZE_THRESHOLD: f32 = 0.10;

// -- Public result types --

#[derive(Clone, Debug)]
pub enum MaximusSource {
    Ollama { iters: u8 },
    Learned(String),
    Passthrough,
    Raw,
}

#[derive(Clone, Debug)]
pub struct MaximusMeta {
    pub content_type: String,
    pub pattern: String,
    pub strategy: String,
    pub chars_in: usize,
    pub chars_out: usize,
    pub source: MaximusSource,
}

impl MaximusMeta {
    fn raw(chars_in: usize) -> Self {
        Self {
            content_type: "unknown".into(),
            pattern: "none".into(),
            strategy: "raw bypass".into(),
            chars_in,
            chars_out: chars_in,
            source: MaximusSource::Raw,
        }
    }

    fn passthrough(chars_in: usize, reason: &str) -> Self {
        Self {
            content_type: "unknown".into(),
            pattern: "none".into(),
            strategy: reason.into(),
            chars_in,
            chars_out: chars_in,
            source: MaximusSource::Passthrough,
        }
    }
}

#[derive(Clone, Debug)]
pub struct MaximusResult {
    pub content: String,
    pub meta: MaximusMeta,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct LearnedPattern {
    pub content_type: String,
    pub pattern: String,
    pub strategy: String,
    pub signature: String,
    pub hit_count: u32,
    pub avg_ratio: f32,
}

struct PipelineResult {
    content_type: String,
    pattern: String,
    strategy: String,
    extracted: String,
    iters: u8,
}

// -- ContextCompressor --

#[derive(Clone)]
pub struct ContextCompressor {
    client: reqwest::Client,
    pub ollama_url: String,
    pub model: String,
    keep_recent: usize,
    ferricula: Option<Arc<FerriculaBackend>>,
    pattern_cache: Arc<RwLock<HashMap<String, LearnedPattern>>>,
    last_meta: Arc<Mutex<Option<MaximusMeta>>>,
    pub disabled: bool,
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
            ferricula: None,
            pattern_cache: Arc::new(RwLock::new(HashMap::new())),
            last_meta: Arc::new(Mutex::new(None)),
            disabled: false,
        }
    }

    pub fn from_env() -> Self {
        let url = std::env::var("OLLAMA_HOST").unwrap_or_else(|_| DEFAULT_OLLAMA_URL.to_string());
        let model = std::env::var("MAXIMUS_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
        let mut comp = Self::new(&url, &model);
        comp.disabled = std::env::var("MAXIMUS_DISABLED").map(|s| s.trim().to_lowercase() == "true" || s.trim() == "1").unwrap_or(false);
        comp
    }

    pub fn get_url(&self) -> String {
        if let Some(cfg) = super::load_config() {
            if let Some(ref url) = cfg.maximus_url {
                return url.clone();
            }
        }
        std::env::var("OLLAMA_HOST").unwrap_or_else(|_| self.ollama_url.clone())
    }

    pub fn get_model(&self) -> String {
        if let Some(cfg) = super::load_config() {
            if let Some(ref model) = cfg.maximus_model {
                return model.clone();
            }
        }
        std::env::var("MAXIMUS_MODEL").unwrap_or_else(|_| self.model.clone())
    }

    pub fn is_disabled(&self) -> bool {
        if let Some(cfg) = super::load_config() {
            if cfg.maximus_disabled {
                return true;
            }
        }
        std::env::var("MAXIMUS_DISABLED").map(|s| s.trim().to_lowercase() == "true" || s.trim() == "1").unwrap_or(self.disabled)
    }

    pub fn from_config(cfg: &super::types::GhostConfig) -> Self {
        let url = cfg.maximus_url.clone()
            .or_else(|| std::env::var("OLLAMA_HOST").ok())
            .unwrap_or_else(|| DEFAULT_OLLAMA_URL.to_string());
        let model = cfg.maximus_model.clone()
            .or_else(|| std::env::var("MAXIMUS_MODEL").ok())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
        let mut comp = Self::new(&url, &model);
        comp.disabled = cfg.maximus_disabled || std::env::var("MAXIMUS_DISABLED").map(|s| s.trim().to_lowercase() == "true" || s.trim() == "1").unwrap_or(false);
        comp
    }

    pub fn with_ferricula(mut self, fc: Arc<FerriculaBackend>) -> Self {
        self.ferricula = Some(fc);
        self
    }

    pub async fn is_available(&self) -> bool {
        if self.is_disabled() {
            return false;
        }
        let ollama_url = self.get_url();
        let model = self.get_model();
        let tags_url = format!("{}/api/tags", ollama_url);
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
                        .map(|n| n == model || n.starts_with(&format!("{}:", model)))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);

        if !model_present {
            info!("maximus: model '{}' not found — pulling in background", model);
            let client = self.client.clone();
            let url = format!("{}/api/pull", ollama_url);
            let model_clone = model.clone();
            tokio::spawn(async move {
                let body = serde_json::json!({"name": model_clone, "stream": false});
                match client.post(&url).json(&body).send().await {
                    Ok(r) if r.status().is_success() => {
                        tracing::info!("maximus: model '{}' pull complete", model_clone)
                    }
                    Ok(r) => tracing::warn!("maximus: model pull returned HTTP {}", r.status()),
                    Err(e) => tracing::warn!("maximus: model pull failed: {}", e),
                }
            });
            return false;
        }

        true
    }

    // -- Message history compression (unchanged) --

    pub async fn compress_messages(&self, messages: &[Value]) -> Vec<Value> {
        self.compress_messages_budgeted(messages, 0, 0).await
    }

    /// Like [`compress_messages`], but honors a hard token budget (plan §3
    /// Phase 3). `budget_tokens == 0` disables the guard (identical to
    /// `compress_messages`). `overhead_chars` is the char length of everything
    /// else in the request the budget must also cover (system prompt + tool
    /// schemas). Tokens are estimated at 4 chars/token. When the estimate blows
    /// the budget, the number of verbatim recent messages kept is stepped down
    /// from the default (6) toward a floor of 2 so system + tools + history fit
    /// (e.g. an 8k Sailfish window).
    pub async fn compress_messages_budgeted(
        &self,
        messages: &[Value],
        budget_tokens: usize,
        overhead_chars: usize,
    ) -> Vec<Value> {
        // Decide how many recent messages to keep verbatim under the budget.
        let mut keep_recent = self.keep_recent;
        if budget_tokens > 0 {
            let history_chars: usize = messages
                .iter()
                .map(|m| serde_json::to_string(m).map(|s| s.len()).unwrap_or(0))
                .sum();
            let est_tokens = (overhead_chars + history_chars) / 4;
            keep_recent = budgeted_keep_recent(self.keep_recent, budget_tokens, est_tokens);
            if keep_recent != self.keep_recent {
                info!(
                    "maximus: context budget {} tok exceeded (~{} tok incl. {} overhead chars) — keep_recent {} → {}",
                    budget_tokens, est_tokens, overhead_chars, self.keep_recent, keep_recent
                );
            }
        }

        if messages.len() <= COMPRESS_THRESHOLD {
            return messages.to_vec();
        }

        let split_at = messages.len().saturating_sub(keep_recent);
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
                // The LLM summarizer is down — do NOT fall back to full history
                // (that's exactly what overflows an 8k window). Trim mechanically
                // so the prompt still fits.
                warn!("maximus: compression failed ({}), hard-trimming to fit budget", e);
                hard_trim_to_budget(messages, budget_tokens, overhead_chars)
            }
        }
    }

    // -- Tool result extraction (new main entrypoint) --

    /// Full Maximus extraction pipeline. Returns annotated result + metadata.
    pub async fn extract_maximus(&self, content: &str, focus: &str, raw: bool) -> MaximusResult {
        let chars_in = content.len();

        if raw {
            let meta = MaximusMeta::raw(chars_in);
            self.store_last(&meta).await;
            return MaximusResult { content: content.to_string(), meta };
        }

        if content.len() < FOCUS_MIN_CHARS && focus.trim().is_empty() {
            let meta = MaximusMeta::passthrough(chars_in, "below threshold");
            self.store_last(&meta).await;
            return MaximusResult { content: content.to_string(), meta };
        }

        match self.run_pipeline(content, focus).await {
            Ok(pr) => {
                let meta = MaximusMeta {
                    content_type: pr.content_type,
                    pattern: pr.pattern,
                    strategy: pr.strategy,
                    chars_in,
                    chars_out: pr.extracted.len(),
                    source: MaximusSource::Ollama { iters: pr.iters },
                };
                self.store_last(&meta).await;
                MaximusResult { content: pr.extracted, meta }
            }
            Err(e) => {
                warn!("maximus: pipeline failed ({}), checking offline patterns", e);
                let offline = self.match_pattern_offline(content).await;
                let meta = match offline {
                    Some(lp) => MaximusMeta {
                        content_type: lp.content_type.clone(),
                        pattern: lp.pattern.clone(),
                        strategy: lp.strategy,
                        chars_in,
                        chars_out: chars_in,
                        source: MaximusSource::Learned(lp.content_type),
                    },
                    None => MaximusMeta::passthrough(chars_in, "ollama unavailable"),
                };
                self.store_last(&meta).await;
                MaximusResult { content: content.to_string(), meta }
            }
        }
    }

    /// Backwards-compatible wrapper — returns only the content string.
    pub async fn extract_focused(&self, content: &str, focus: &str) -> String {
        self.extract_maximus(content, focus, false).await.content
    }

    /// Return the metadata from the last extraction for maximus_explain.
    pub async fn explain_last(&self) -> String {
        let guard = self.last_meta.lock().await;
        match &*guard {
            None => "No Maximus extraction has been performed yet this session.".to_string(),
            Some(m) => {
                let ratio = if m.chars_in > 0 {
                    100.0 * m.chars_out as f32 / m.chars_in as f32
                } else {
                    100.0
                };
                let source_str = match &m.source {
                    MaximusSource::Ollama { iters } => format!("Ollama ({iters} iterations)"),
                    MaximusSource::Learned(name) => format!("learned pattern: {name}"),
                    MaximusSource::Passthrough => "passthrough (no compression)".into(),
                    MaximusSource::Raw => "raw bypass".into(),
                };
                format!(
                    "type: {}\npattern: {}\nsource: {}\nstrategy: {}\ncompression: {} → {} chars ({:.0}% of original)",
                    m.content_type, m.pattern, source_str, m.strategy,
                    m.chars_in, m.chars_out, ratio
                )
            }
        }
    }

    /// Format the [tokenmax …] annotation to prepend to tool results.
    /// Returns empty string when annotation would be pure noise (e.g. short passthrough).
    pub fn format_annotation(meta: &MaximusMeta, focus_used: bool, raw_used: bool) -> String {
        match &meta.source {
            MaximusSource::Raw => "[tokenmax:raw]\n".to_string(),
            MaximusSource::Passthrough => {
                if meta.strategy == "below threshold" {
                    String::new()
                } else {
                    "[tokenmax:passthrough — Ollama unavailable, full output shown]\n\
                     [hints: start Ollama with `ollama serve` to enable tokenmax]\n"
                        .to_string()
                }
            }
            MaximusSource::Learned(name) => {
                format!(
                    "[tokenmax type={} pattern={} src=learned|offline {}→{}chars]\n\
                     [hints: raw=true → full output | maximus_explain → pattern detail]\n",
                    meta.content_type, name, meta.chars_in, meta.chars_out
                )
            }
            MaximusSource::Ollama { iters } => {
                let mut hints: Vec<&str> = Vec::new();
                if !raw_used {
                    hints.push("raw=true → full output");
                }
                if !focus_used {
                    hints.push("focus=\"<topic>\" → targeted extract");
                }
                hints.push("maximus_explain → pattern detail");
                format!(
                    "[tokenmax type={} pattern={} src=ollama/{}i {}→{}chars]\n[hints: {}]\n",
                    meta.content_type,
                    meta.pattern,
                    iters,
                    meta.chars_in,
                    meta.chars_out,
                    hints.join(" | ")
                )
            }
        }
    }

    // -- Pattern memory --

    pub async fn load_patterns_from_ferricula(&self) {
        if let Some(fc) = &self.ferricula {
            let entries = fc.list_channel("maximus-patterns").await;
            if entries.is_empty() {
                return;
            }
            let mut cache = self.pattern_cache.write().await;
            for entry in entries {
                if let Ok(p) = serde_json::from_str::<LearnedPattern>(&entry) {
                    cache.insert(p.content_type.clone(), p);
                }
            }
            info!("maximus: loaded {} learned patterns", cache.len());
        }
    }

    async fn save_pattern(&self, pattern: LearnedPattern) {
        if let Some(fc) = &self.ferricula {
            if let Ok(json) = serde_json::to_string(&pattern) {
                fc.remember(&json, "maximus-patterns").await;
            }
        }
        let mut cache = self.pattern_cache.write().await;
        cache.insert(pattern.content_type.clone(), pattern);
    }

    async fn match_pattern_offline(&self, content: &str) -> Option<LearnedPattern> {
        let type_hint = detect_content_type(content)?;
        let cache = self.pattern_cache.read().await;
        cache.get(&type_hint).cloned()
    }

    // -- Ollama pipeline --

    async fn run_pipeline(&self, content: &str, focus: &str) -> anyhow::Result<PipelineResult> {
        let cached = self.match_pattern_offline(content).await;

        let (content_type, strategy) = if let Some(ref lp) = cached {
            (lp.content_type.clone(), lp.strategy.clone())
        } else {
            let ct = self.classify_content(content).await?;
            let st = self.derive_strategy(content, &ct).await?;
            (ct, st)
        };

        let mut current = content.to_string();
        let mut iters = 0u8;
        let mut prev_len = content.len();

        for i in 0..MAX_ITERS {
            let next = self.apply_strategy(&current, &strategy, focus).await?;
            if next.trim().is_empty() {
                break;
            }
            iters = i + 1;
            let change = if prev_len > 0 {
                (prev_len as f32 - next.len() as f32).abs() / prev_len as f32
            } else {
                0.0
            };
            prev_len = next.len();
            current = next;
            if i > 0 && change < STABILIZE_THRESHOLD {
                break;
            }
        }

        let pattern_name = cached
            .as_ref()
            .map(|lp| lp.pattern.clone())
            .unwrap_or_else(|| content_type.clone());

        if cached.is_none() && current.len() < content.len() {
            let first = content.lines().next().unwrap_or("").trim();
            let sig = crate::util::safe_prefix(first, 40);
            let lp = LearnedPattern {
                content_type: content_type.clone(),
                pattern: pattern_name.clone(),
                strategy: strategy.clone(),
                signature: format!("starts:{}", sig),
                hit_count: 1,
                avg_ratio: current.len() as f32 / content.len().max(1) as f32,
            };
            self.save_pattern(lp).await;
            info!(
                "maximus: learned pattern '{}' (ratio {:.0}%)",
                content_type,
                100.0 * current.len() as f32 / content.len().max(1) as f32
            );
        }

        Ok(PipelineResult {
            content_type,
            pattern: pattern_name,
            strategy,
            extracted: current,
            iters,
        })
    }

    async fn classify_content(&self, content: &str) -> anyhow::Result<String> {
        // Truncate at a UTF-8 char boundary ≤ 800 bytes. Slicing at a raw byte
        // index (content[..800]) panics with "byte index N is not a char
        // boundary" when byte 800 lands mid-character — and terminal output is
        // full of multi-byte chars (emoji, box-drawing). That panic was crashing
        // the whole sidecar.
        let mut end = content.len().min(800);
        while end > 0 && !content.is_char_boundary(end) {
            end -= 1;
        }
        let snippet = &content[..end];
        // Structured output: constrain the model to a JSON object with a single
        // `content_type` field. This is what stops chatty/weaker models (e.g.
        // gemma) from replying "Okay, I understand…" instead of a label — they
        // physically can't emit anything but the schema. temperature 0 = stable.
        let body = serde_json::json!({
            "model": self.get_model(),
            "messages": [
                {
                    "role": "system",
                    "content": "Classify the content type of the text. Fill the `content_type` field with a \
                        2-4 word kebab-case label (e.g. cargo-test-output, json-blob, git-diff, \
                        rust-compiler-output, http-response, shell-session, log-output, file-contents, \
                        terminal-screen)."
                },
                {"role": "user", "content": snippet}
            ],
            "stream": false,
            "options": {"temperature": 0},
            "format": {
                "type": "object",
                "properties": {"content_type": {"type": "string", "description": "2-4 word kebab-case content-type label"}},
                "required": ["content_type"]
            }
        });

        let json = self.chat_structured(&body, "classify").await?;
        json["content_type"]
            .as_str()
            .map(|s| s.trim().to_lowercase().replace(' ', "-"))
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("no content_type in classify response"))
    }

    /// POST a /api/chat request whose `format` is a JSON schema, and parse the
    /// model's (schema-constrained) reply into a Value. Structured outputs are
    /// what make extraction reliable across models: the reply can ONLY match the
    /// schema, so a chatty model physically can't preamble ("Okay, I understand…").
    async fn chat_structured(&self, body: &Value, what: &str) -> anyhow::Result<Value> {
        let resp = self
            .client
            .post(format!("{}/api/chat", self.get_url()))
            .json(body)
            .send()
            .await?;
        if !resp.status().is_success() {
            anyhow::bail!("Ollama {what} returned HTTP {}", resp.status());
        }
        let envelope: Value = resp.json().await?;
        let content = envelope["message"]["content"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("no message content in {what} response"))?;
        serde_json::from_str::<Value>(content).map_err(|e| {
            anyhow::anyhow!(
                "{what}: model did not return schema JSON ({e}): {}",
                crate::util::safe_prefix(content, 120)
            )
        })
    }

    async fn derive_strategy(&self, content: &str, content_type: &str) -> anyhow::Result<String> {
        let snippet = crate::util::safe_prefix(content, 800);
        let body = serde_json::json!({
            "model": self.get_model(),
            "messages": [
                {
                    "role": "system",
                    "content": "Decide what to extract when summarizing this content. Fill `strategy` \
                        with ONE specific sentence naming which fields, lines, or patterns matter."
                },
                {
                    "role": "user",
                    "content": format!("Content type: {content_type}\n\nContent:\n{snippet}")
                }
            ],
            "stream": false,
            "options": {"temperature": 0},
            "format": {
                "type": "object",
                "properties": {"strategy": {"type": "string", "description": "one specific extraction-strategy sentence"}},
                "required": ["strategy"]
            }
        });

        let json = self.chat_structured(&body, "strategize").await?;
        json["strategy"]
            .as_str()
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("no strategy in response"))
    }

    async fn apply_strategy(
        &self,
        content: &str,
        strategy: &str,
        focus: &str,
    ) -> anyhow::Result<String> {
        let focus_clause = if focus.trim().is_empty() {
            String::new()
        } else {
            format!(" The caller is specifically looking for: {focus}.")
        };
        let body = serde_json::json!({
            "model": self.get_model(),
            "messages": [
                {
                    "role": "system",
                    "content": format!(
                        "Apply this extraction strategy to the content: {strategy}.{focus_clause} \
                         Put ONLY the extracted information (verbatim where possible) in `extracted`. \
                         Set `found` to true if the requested information is present in the content, \
                         false if it is not."
                    )
                },
                {"role": "user", "content": content}
            ],
            "stream": false,
            "options": {"temperature": 0},
            "format": {
                "type": "object",
                "properties": {
                    "extracted": {"type": "string", "description": "the extracted information, verbatim where possible"},
                    "found": {"type": "boolean", "description": "true if the requested info was present"}
                },
                "required": ["extracted", "found"]
            }
        });

        let json = self.chat_structured(&body, "apply").await?;
        let found = json["found"].as_bool().unwrap_or(true);
        let extracted = json["extracted"].as_str().unwrap_or("").trim().to_string();
        // Don't SWALLOW output on a focus miss. The old prompt returned
        // "Not found: <topic>" which discarded the real content — an agent then
        // thought the command produced nothing. Instead, when the model couldn't
        // find the requested info (or returned nothing), hand back the content
        // unchanged so the agent still sees everything.
        if !found || extracted.is_empty() {
            return Ok(content.to_string());
        }
        Ok(extracted)
    }

    async fn summarize(&self, messages: &[Value]) -> anyhow::Result<String> {
        let text = render_messages(messages);
        let body = serde_json::json!({
            "model": self.get_model(),
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
                {"role": "user", "content": text}
            ],
            "stream": false
        });

        let resp = self
            .client
            .post(format!("{}/api/chat", self.get_url()))
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

    async fn store_last(&self, meta: &MaximusMeta) {
        let mut guard = self.last_meta.lock().await;
        *guard = Some(meta.clone());
    }
}

// -- Token-budget guard (plan §3 Phase 3) --

/// How many recent messages to keep verbatim under a hard token budget.
///
/// Returns `default_keep` when the budget is off (`0`) or the estimate fits.
/// Otherwise steps down one message per ~1/8 of the budget the estimate is
/// over, floored at 2 (never drops below the two most recent turns).
/// Mechanical, LLM-free trim: keep the newest messages that fit within the
/// token budget (chars/4 estimate, incl. `overhead_chars` for system+tools),
/// dropping the oldest. Always keeps at least the final message (the current
/// turn). Strips any leading orphaned `tool` result so the trimmed history
/// doesn't 400 the provider ("tool message must follow tool_calls"), and
/// prepends a short note when history was dropped. Used when the LLM
/// compressor is unavailable/failed — the last line of defense against a
/// context-window overflow.
pub fn hard_trim_to_budget(messages: &[Value], budget_tokens: usize, overhead_chars: usize) -> Vec<Value> {
    if budget_tokens == 0 || messages.is_empty() {
        return messages.to_vec();
    }
    let est = |m: &Value| serde_json::to_string(m).map(|s| s.len()).unwrap_or(0) / 4;
    let mut budget = budget_tokens.saturating_sub(overhead_chars / 4);
    let mut kept: Vec<Value> = Vec::new();
    for m in messages.iter().rev() {
        let t = est(m);
        // Always keep the newest message even if it alone blows the budget —
        // sending a too-big current turn is the provider's problem to report,
        // whereas sending nothing is useless.
        if kept.is_empty() || t <= budget {
            budget = budget.saturating_sub(t);
            kept.push(m.clone());
        } else {
            break;
        }
    }
    kept.reverse();
    // Drop a leading tool-result whose parent assistant/tool_calls got trimmed.
    while kept
        .first()
        .and_then(|m| m["role"].as_str())
        .map_or(false, |r| r == "tool")
    {
        kept.remove(0);
    }
    let dropped = messages.len() - kept.len();
    if dropped == 0 {
        return kept;
    }
    info!(
        "maximus: hard-trimmed {} old message(s) to fit ~{} tok context budget",
        dropped, budget_tokens
    );
    let mut out = Vec::with_capacity(kept.len() + 1);
    out.push(serde_json::json!({
        "role": "user",
        "content": format!(
            "[{} earlier message(s) were dropped to fit the model's context window. Ask the human if you need lost detail.]",
            dropped
        )
    }));
    out.extend(kept);
    out
}

fn budgeted_keep_recent(default_keep: usize, budget_tokens: usize, est_tokens: usize) -> usize {
    if budget_tokens == 0 || est_tokens <= budget_tokens {
        return default_keep;
    }
    let over = est_tokens - budget_tokens;
    let step = (budget_tokens / 8).max(1);
    let drop = (over / step).min(default_keep.saturating_sub(2));
    default_keep.saturating_sub(drop).max(2)
}

// -- Heuristic content type detection (offline, no Ollama) --

fn detect_content_type(content: &str) -> Option<String> {
    let first = content.lines().next().unwrap_or("").trim();

    if (first.starts_with("running ") && (first.ends_with(" tests") || first.ends_with(" test")))
        || content.contains("test result: ok")
        || content.contains("test result: FAILED")
    {
        return Some("cargo-test-output".into());
    }
    if content.starts_with('{') || content.starts_with('[') {
        return Some("json-blob".into());
    }
    if content.starts_with("diff --git") || content.contains("\n@@") {
        return Some("git-diff".into());
    }
    if content.contains("error[E") || (content.contains("warning:") && content.contains(" --> ")) {
        return Some("rust-compiler-output".into());
    }
    if first.starts_with("HTTP/") {
        return Some("http-response".into());
    }
    None
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
                    Some(format!("[tool_result: {}]", crate::util::safe_prefix(content, 200)))
                }
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" "),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> Value {
        serde_json::json!({"role": role, "content": content})
    }

    fn msgs(n: usize) -> Vec<Value> {
        (0..n)
            .map(|i| msg(if i % 2 == 0 { "user" } else { "assistant" }, &format!("message {}", i)))
            .collect()
    }

    // --- Construction ---

    #[test]
    fn new_stores_fields() {
        let c = ContextCompressor::new("http://my-ollama:1234", "llama3");
        assert_eq!(c.ollama_url, "http://my-ollama:1234");
        assert_eq!(c.model, "llama3");
    }

    #[test]
    fn new_strips_trailing_slash() {
        let c = ContextCompressor::new("http://localhost:11434/", "m");
        assert_eq!(c.ollama_url, "http://localhost:11434");
    }

    #[test]
    fn from_env_defaults() {
        std::env::remove_var("OLLAMA_HOST");
        std::env::remove_var("MAXIMUS_MODEL");
        let c = ContextCompressor::from_env();
        assert_eq!(c.ollama_url, "http://localhost:11434");
        assert_eq!(c.model, "gemma2:2b");
    }

    #[test]
    fn from_env_reads_vars() {
        std::env::set_var("OLLAMA_HOST", "http://custom:9999");
        std::env::set_var("MAXIMUS_MODEL", "mistral");
        let c = ContextCompressor::from_env();
        std::env::remove_var("OLLAMA_HOST");
        std::env::remove_var("MAXIMUS_MODEL");
        assert_eq!(c.ollama_url, "http://custom:9999");
        assert_eq!(c.model, "mistral");
    }

    #[test]
    fn getters_prefer_config_then_env_then_fields() {
        let temp_dir = std::env::temp_dir().join(format!("hyperia_test_{}", std::process::id()));
        let config_dir = temp_dir.join(".hyperia");
        std::fs::create_dir_all(&config_dir).unwrap();
        let config_file = config_dir.join("hyperia.json");

        let config_json = serde_json::json!({
            "config": {
                "maximus": {
                    "model": "gemma2:9b-mock",
                    "url": "http://mock-ollama:11434",
                    "disabled": true
                }
            }
        });
        std::fs::write(&config_file, serde_json::to_string(&config_json).unwrap()).unwrap();

        std::env::set_var("HYPERIA_MOCK_HOME", temp_dir.to_str().unwrap());
        std::env::set_var("OLLAMA_HOST", "http://env-ollama:11434");
        std::env::set_var("MAXIMUS_MODEL", "gemma2:env-model");
        std::env::set_var("MAXIMUS_DISABLED", "false");

        let c = ContextCompressor::new("http://default-ollama:11434", "gemma2:default-model");
        assert_eq!(c.get_url(), "http://mock-ollama:11434");
        assert_eq!(c.get_model(), "gemma2:9b-mock");
        assert!(c.is_disabled());

        let config_json_empty = serde_json::json!({
            "config": {
                "maximus": {}
            }
        });
        std::fs::write(&config_file, serde_json::to_string(&config_json_empty).unwrap()).unwrap();
        
        assert_eq!(c.get_url(), "http://env-ollama:11434");
        assert_eq!(c.get_model(), "gemma2:env-model");
        std::env::remove_var("OLLAMA_HOST");
        std::env::remove_var("MAXIMUS_MODEL");
        std::env::remove_var("MAXIMUS_DISABLED");
        
        assert_eq!(c.get_url(), "http://default-ollama:11434");
        assert_eq!(c.get_model(), "gemma2:default-model");
        assert!(!c.is_disabled());

        std::env::remove_var("HYPERIA_MOCK_HOME");
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    // --- compress_messages: passthrough when under threshold ---

    #[tokio::test]
    async fn compress_passthrough_at_threshold() {
        let c = ContextCompressor::new("http://127.0.0.1:1", "m");
        let input = msgs(COMPRESS_THRESHOLD);
        let out = c.compress_messages(&input).await;
        assert_eq!(out.len(), input.len());
        assert_eq!(out, input);
    }

    #[tokio::test]
    async fn compress_passthrough_under_threshold() {
        let c = ContextCompressor::new("http://127.0.0.1:1", "m");
        let input = msgs(3);
        let out = c.compress_messages(&input).await;
        assert_eq!(out, input);
    }

    #[tokio::test]
    async fn compress_empty_list() {
        let c = ContextCompressor::new("http://127.0.0.1:1", "m");
        let out = c.compress_messages(&[]).await;
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn compress_fallback_when_ollama_down() {
        let c = ContextCompressor::new("http://127.0.0.1:1", "m");
        let input = msgs(COMPRESS_THRESHOLD + 5);
        let out = c.compress_messages(&input).await;
        assert_eq!(out, input);
    }

    // --- extract_maximus: raw bypass ---

    #[tokio::test]
    async fn extract_maximus_raw_returns_original() {
        let c = ContextCompressor::new("http://127.0.0.1:1", "m");
        let content = "x".repeat(1000);
        let result = c.extract_maximus(&content, "find something", true).await;
        assert_eq!(result.content, content);
        assert!(matches!(result.meta.source, MaximusSource::Raw));
    }

    #[tokio::test]
    async fn extract_maximus_short_passthrough() {
        let c = ContextCompressor::new("http://127.0.0.1:1", "m");
        let content = "hello world";
        let result = c.extract_maximus(content, "", false).await;
        assert_eq!(result.content, content);
        assert!(matches!(result.meta.source, MaximusSource::Passthrough));
    }

    #[tokio::test]
    async fn extract_maximus_ollama_down_returns_original() {
        let c = ContextCompressor::new("http://127.0.0.1:1", "m");
        let content = "x".repeat(FOCUS_MIN_CHARS + 1);
        let result = c.extract_maximus(&content, "find something", false).await;
        assert_eq!(result.content, content);
        assert!(matches!(result.meta.source, MaximusSource::Passthrough));
    }

    // --- extract_focused backwards compat ---

    #[tokio::test]
    async fn extract_focused_short_content_passthrough() {
        let c = ContextCompressor::new("http://127.0.0.1:1", "m");
        let short = "hello world";
        let out = c.extract_focused(short, "find greeting").await;
        assert_eq!(out, short);
    }

    #[tokio::test]
    async fn extract_focused_empty_focus_passthrough() {
        let c = ContextCompressor::new("http://127.0.0.1:1", "m");
        let long = "x".repeat(FOCUS_MIN_CHARS + 1);
        let out = c.extract_focused(&long, "   ").await;
        assert_eq!(out, long);
    }

    #[tokio::test]
    async fn extract_focused_fallback_when_ollama_down() {
        let c = ContextCompressor::new("http://127.0.0.1:1", "m");
        let long = "x".repeat(FOCUS_MIN_CHARS + 1);
        let out = c.extract_focused(&long, "find something").await;
        assert_eq!(out, long);
    }

    // --- format_annotation ---

    #[test]
    fn annotation_raw() {
        let meta = MaximusMeta::raw(500);
        let ann = ContextCompressor::format_annotation(&meta, false, true);
        assert!(ann.contains("tokenmax:raw"));
    }

    #[test]
    fn annotation_passthrough_below_threshold() {
        let meta = MaximusMeta::passthrough(100, "below threshold");
        let ann = ContextCompressor::format_annotation(&meta, false, false);
        assert!(ann.is_empty(), "short passthrough should produce no annotation");
    }

    #[test]
    fn annotation_passthrough_ollama_down() {
        let meta = MaximusMeta::passthrough(1000, "ollama unavailable");
        let ann = ContextCompressor::format_annotation(&meta, false, false);
        assert!(ann.contains("tokenmax:passthrough"));
        assert!(ann.contains("ollama serve"));
    }

    #[test]
    fn annotation_ollama_includes_hints() {
        let meta = MaximusMeta {
            content_type: "cargo-test-output".into(),
            pattern: "exit-code-lines".into(),
            strategy: "extract pass/fail counts".into(),
            chars_in: 1000,
            chars_out: 50,
            source: MaximusSource::Ollama { iters: 2 },
        };
        let ann = ContextCompressor::format_annotation(&meta, false, false);
        assert!(ann.contains("tokenmax type=cargo-test-output"));
        assert!(ann.contains("ollama/2i"));
        assert!(ann.contains("1000→50chars"));
        assert!(ann.contains("raw=true"));
        assert!(ann.contains("focus="));
        assert!(ann.contains("maximus_explain"));
    }

    #[test]
    fn annotation_ollama_adaptive_hints_focus_used() {
        let meta = MaximusMeta {
            content_type: "json-blob".into(),
            pattern: "json-blob".into(),
            strategy: "extract key fields".into(),
            chars_in: 800,
            chars_out: 40,
            source: MaximusSource::Ollama { iters: 1 },
        };
        // focus was already used — don't hint it again
        let ann = ContextCompressor::format_annotation(&meta, true, false);
        assert!(!ann.contains("focus="), "should not hint focus= when already used");
        assert!(ann.contains("raw=true"));
    }

    // --- budgeted_keep_recent (token budget guard) ---

    #[test]
    fn budget_off_keeps_default() {
        assert_eq!(budgeted_keep_recent(6, 0, 999_999), 6);
    }

    #[test]
    fn budget_under_keeps_default() {
        assert_eq!(budgeted_keep_recent(6, 8000, 5000), 6);
    }

    #[test]
    fn budget_slightly_over_drops_one() {
        // 8000 budget, step = 1000. Over by 1200 → drop 1 → 5.
        assert_eq!(budgeted_keep_recent(6, 8000, 9200), 5);
    }

    #[test]
    fn budget_way_over_floors_at_two() {
        // Massively over budget → floored at 2, never lower.
        assert_eq!(budgeted_keep_recent(6, 8000, 200_000), 2);
    }

    #[test]
    fn budget_never_below_two_even_at_boundary() {
        // Exactly at budget → no reduction.
        assert_eq!(budgeted_keep_recent(6, 8000, 8000), 6);
        // Small default already at floor stays at floor.
        assert_eq!(budgeted_keep_recent(2, 8000, 100_000), 2);
    }

    #[tokio::test]
    async fn compress_budgeted_zero_matches_plain() {
        let c = ContextCompressor::new("http://127.0.0.1:1", "m");
        let input = msgs(COMPRESS_THRESHOLD + 5);
        let plain = c.compress_messages(&input).await;
        let budgeted = c.compress_messages_budgeted(&input, 0, 0).await;
        assert_eq!(plain, budgeted);
    }

    // --- detect_content_type heuristic ---

    #[test]
    fn detect_cargo_test() {
        let content = "running 4 tests\ntest foo ... ok\ntest result: ok. 4 passed; 0 failed";
        assert_eq!(detect_content_type(content), Some("cargo-test-output".into()));
    }

    #[test]
    fn detect_json_blob() {
        let content = r#"{"key": "value", "count": 42}"#;
        assert_eq!(detect_content_type(content), Some("json-blob".into()));
    }

    #[test]
    fn detect_git_diff() {
        let content = "diff --git a/foo.rs b/foo.rs\nindex abc..def 100644\n@@ -1,3 +1,4 @@";
        assert_eq!(detect_content_type(content), Some("git-diff".into()));
    }

    #[test]
    fn detect_rust_compiler() {
        let content = "error[E0308]: mismatched types\n --> src/main.rs:10:5";
        assert_eq!(detect_content_type(content), Some("rust-compiler-output".into()));
    }

    #[test]
    fn detect_unknown() {
        let content = "some random text that doesn't match anything";
        assert_eq!(detect_content_type(content), None);
    }

    // --- render_messages / extract_content ---

    #[test]
    fn render_messages_simple() {
        let msgs = vec![msg("user", "hello"), msg("assistant", "world")];
        let rendered = render_messages(&msgs);
        assert!(rendered.contains("user: hello"));
        assert!(rendered.contains("assistant: world"));
    }

    #[test]
    fn extract_content_string() {
        let v = Value::String("plain text".into());
        assert_eq!(extract_content(&v), "plain text");
    }

    #[test]
    fn extract_content_array_text_parts() {
        let v = serde_json::json!([
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"}
        ]);
        let out = extract_content(&v);
        assert!(out.contains("first"));
        assert!(out.contains("second"));
    }

    #[test]
    fn extract_content_tool_use() {
        let v = serde_json::json!([
            {"type": "tool_use", "name": "shell_run", "input": {"cmd": "ls"}}
        ]);
        let out = extract_content(&v);
        assert!(out.contains("tool_use: shell_run"));
    }

    #[test]
    fn extract_content_tool_result_truncates() {
        let long = "a".repeat(300);
        let v = serde_json::json!([
            {"type": "tool_result", "content": long}
        ]);
        let out = extract_content(&v);
        assert!(out.len() < 300);
    }

    // --- Live integration tests (require Ollama running with gemma2:2b) ---
    // Run with: cargo test ghost::compressor::tests::live -- --ignored --nocapture

    fn agent_msgs() -> Vec<Value> {
        vec![
            serde_json::json!({"role":"user","content":"What's running in the terminal? Then run the sidecar tests."}),
            serde_json::json!({"role":"assistant","content":[
                {"type":"text","text":"Let me check the terminal state first."},
                {"type":"tool_use","name":"terminal_status","input":{}}
            ]}),
            serde_json::json!({"role":"user","content":[
                {"type":"tool_result","content":"{\"windows\":[{\"id\":1,\"tabs\":[{\"name\":\"maximus\",\"panes\":[{\"pid\":9288,\"process\":\"pwsh\",\"rows\":68}]}]}]}"}
            ]}),
            serde_json::json!({"role":"assistant","content":[
                {"type":"text","text":"One window, one tab named maximus running pwsh. Running the tests now."},
                {"type":"tool_use","name":"terminal_run","input":{"command":"cargo test ghost::compressor -- --nocapture 2>&1","tab":"maximus"}}
            ]}),
            serde_json::json!({"role":"user","content":[
                {"type":"tool_result","content":"running 16 tests\ntest ghost::compressor::tests::new_stores_fields ... ok\ntest ghost::compressor::tests::compress_fallback_when_ollama_down ... ok\ntest result: ok. 16 passed; 0 failed; finished in 2.04s"}
            ]}),
            serde_json::json!({"role":"assistant","content":"All 16 unit tests passed. No failures."}),
            serde_json::json!({"role":"user","content":"Good. Now check if Ollama is up and what model is loaded."}),
            serde_json::json!({"role":"assistant","content":[
                {"type":"tool_use","name":"terminal_run","input":{"command":"curl -s http://localhost:11434/api/tags | jq '.models[].name'","tab":"maximus"}}
            ]}),
            serde_json::json!({"role":"user","content":[
                {"type":"tool_result","content":"\"gemma2:2b\"\n\"llama3.2:3b\""}
            ]}),
            serde_json::json!({"role":"assistant","content":"Ollama is up. Two models available: gemma2:2b and llama3.2:3b."}),
            serde_json::json!({"role":"user","content":"Run the live integration tests too."}),
            serde_json::json!({"role":"assistant","content":[
                {"type":"tool_use","name":"terminal_run","input":{"command":"cargo test ghost::compressor::tests::live -- --ignored --nocapture 2>&1","tab":"maximus"}}
            ]}),
            serde_json::json!({"role":"user","content":[
                {"type":"tool_result","content":"running 4 tests\ntest live_is_available ... ok\ntest live_compress_messages ... ok\ntest live_extract_focused ... ok\ntest live_extract_focused_absent_focus ... ok\ntest result: ok. 4 passed; 0 failed; finished in 5.75s"}
            ]}),
            serde_json::json!({"role":"assistant","content":"All 4 live tests passed against the real Ollama instance."}),
            serde_json::json!({"role":"user","content":"Perfect. Commit the tests."}),
            serde_json::json!({"role":"assistant","content":[
                {"type":"tool_use","name":"terminal_run","input":{"command":"git add sidecar/src/ghost/compressor.rs && git commit -m 'Add live integration tests for ContextCompressor'","tab":"maximus"}}
            ]}),
            serde_json::json!({"role":"user","content":[
                {"type":"tool_result","content":"[canary abc1234] Add live integration tests for ContextCompressor\n 1 file changed, 60 insertions(+)"}
            ]}),
            serde_json::json!({"role":"assistant","content":"Committed. Branch canary is ahead of origin by 1 commit."}),
        ]
    }

    #[tokio::test]
    #[ignore]
    async fn live_is_available() {
        let c = ContextCompressor::from_env();
        let available = c.is_available().await;
        println!("Ollama available: {available}  url={} model={}", c.ollama_url, c.model);
        assert!(available, "Ollama must be running with model '{}'", c.model);
    }

    #[tokio::test]
    #[ignore]
    async fn live_compress_messages() {
        let c = ContextCompressor::from_env();
        let input = agent_msgs();
        println!("Input: {} msgs (tool_use + tool_result blocks)", input.len());
        let out = c.compress_messages(&input).await;
        println!("\nOutput: {} msgs", out.len());
        for m in &out {
            println!(
                "  [{}] {}",
                m["role"].as_str().unwrap_or("?"),
                m["content"]
                    .as_str()
                    .map(|s| crate::util::safe_prefix(s, 120))
                    .unwrap_or("(blocks)")
            );
        }
        assert!(
            out.len() < input.len(),
            "expected compression: {} → {}",
            input.len(),
            out.len()
        );
        let summary = out[0]["content"].as_str().unwrap_or("");
        println!("\nSummary:\n{summary}");
        assert!(summary.starts_with("[Earlier context"), "expected compressed context header");
        assert_eq!(out[1]["content"], "Context noted.");
    }

    #[tokio::test]
    #[ignore]
    async fn live_classify_content() {
        let c = ContextCompressor::from_env();
        let cargo_output = "running 4 tests\ntest foo ... ok\ntest bar ... ok\ntest result: ok. 4 passed; 0 failed; finished in 1.2s";
        let ct = c.classify_content(cargo_output).await.unwrap();
        println!("classified as: {ct}");
        assert!(
            ct.contains("cargo") || ct.contains("test"),
            "expected cargo-test type, got: {ct}"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn live_iterative_extract() {
        let c = ContextCompressor::from_env();
        let screen = r#"running 4 tests
focus="port number"
input=The server started on port 8080. There were 3 warnings about deprecated APIs.
output=The server started on port 8080. There were 3 warnings about deprecated APIs.
test ghost::compressor::tests::live_extract_focused_from_screen_dump ... ok
Ollama available: true  url=http://localhost:11434 model=gemma2:2b
test ghost::compressor::tests::live_is_available ... ok
test ghost::compressor::tests::live_compress_messages ... ok
output: The kubernetes cluster name is not present in the output.
test ghost::compressor::tests::live_extract_focused_absent_focus ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 18 filtered out; finished in 5.75s"#;

        let result = c.extract_maximus(screen, "how many tests passed and did any fail", false).await;
        println!("source: {:?}", result.meta.source);
        println!("type: {}", result.meta.content_type);
        println!("iters: {:?}", if let MaximusSource::Ollama { iters } = result.meta.source { iters } else { 0 });
        println!("{}→{} chars", result.meta.chars_in, result.meta.chars_out);
        println!("output: {}", result.content);
        assert!(!result.content.is_empty());
        assert!(result.content.contains('4') || result.content.to_lowercase().contains("pass"));
    }

    #[tokio::test]
    #[ignore]
    async fn live_extract_focused_from_screen_dump() {
        let screen = r#"running 4 tests
focus="port number"
input=The server started on port 8080. There were 3 warnings about deprecated APIs.
output=The server started on port 8080. There were 3 warnings about deprecated APIs.
test ghost::compressor::tests::live_extract_focused_from_screen_dump ... ok
Ollama available: true  url=http://localhost:11434 model=gemma2:2b
test ghost::compressor::tests::live_is_available ... ok
test ghost::compressor::tests::live_compress_messages ... ok
output: The kubernetes cluster name is not present in the output.
test ghost::compressor::tests::live_extract_focused_absent_focus ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 18 filtered out; finished in 5.75s"#;

        let c = ContextCompressor::from_env();

        let out = c.extract_focused(screen, "how many tests passed and did any fail").await;
        println!("focus: test results summary\noutput: {out}");
        assert!(!out.is_empty());
        assert!(out.contains('4') || out.to_lowercase().contains("pass"), "expected pass count in: {out}");

        let out2 = c.extract_focused(screen, "which model is Ollama using").await;
        println!("focus: ollama model\noutput: {out2}");
        assert!(out2.contains("gemma2") || out2.contains("2b"), "expected model name in: {out2}");
    }

    #[tokio::test]
    #[ignore]
    async fn live_extract_focused_absent_focus() {
        let c = ContextCompressor::from_env();
        let screen = r#"running 4 tests
test ghost::compressor::tests::live_is_available ... ok
test ghost::compressor::tests::live_compress_messages ... ok
test ghost::compressor::tests::live_extract_focused ... ok
test ghost::compressor::tests::live_extract_focused_absent_focus ... ok
test result: ok. 4 passed; 0 failed; finished in 5.75s
PS C:\Users\kordl\Code\DeepBlueDynamics\hyperia\sidecar>"#;
        let out = c.extract_focused(screen, "database connection error").await;
        println!("output ({} chars): {out}", out.len());
        assert!(!out.is_empty());
    }
}
