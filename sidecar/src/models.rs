//! models.rs — the single source of truth for model knowledge.
//!
//! Every "which model / how does this model behave" fact lives HERE, not
//! scattered through providers, bootstub, doors, api handlers, or HTML.
//! Consumers: ghost/mod.rs + bootstub.rs (defaults), ghost/provider.rs
//! (endpoint routing + token param naming), doors.rs (small-model
//! classification), ghost/api.rs (curated ollama list + UI defaults served
//! via /api/ghost/capabilities so shell.html stops hardcoding model ids).
//!
//! History: a stale `claude-opus-4-7` sat in the picker catalog and
//! `claude-sonnet-4-6` was duplicated as the anthropic default in THREE
//! places (ghost/mod.rs, bootstub.rs, provider.rs) — nobody noticed because
//! there was no one place to look. That's the failure mode this module ends.

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/// Default model when the user has set a provider but no model. UI pickers
/// receive this via /api/ghost/capabilities `model_defaults` — do not
/// duplicate these ids in HTML/JS.
/// Defaults are each provider's TOP CHEAP/FAST model (per user policy) — the
/// picker offers the full catalog for stepping up.
pub fn default_model(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "claude-haiku-4-5",
        "openai" => "gpt-5-mini",
        "gemini" => "gemini-3-flash-preview",
        "ollama" => "gemma2:9b",
        // Sailfish: the integration guide's reference client uses "gemma4-e4b"
        // (gemma-4-E4B-it Q4_K_M). Only a fallback — the served id can swap
        // (stock vs fine-tuned); authoritative source is GET /v1/models,
        // probed live by ghost/api.rs get_agent_models.
        "sailfish" => "gemma4-e4b",
        _ => "gemma2:9b",
    }
}

/// Per-provider defaults as JSON for the shell/config UI (served on
/// capabilities). Keys match the provider ids the UI uses.
pub fn model_defaults_json() -> serde_json::Value {
    serde_json::json!({
        "anthropic": default_model("anthropic"),
        "openai":    default_model("openai"),
        "gemini":    default_model("gemini"),
        "ollama":    default_model("ollama"),
        "sailfish":  default_model("sailfish"),
    })
}

/// Default model for the Maximus compressor/extractor (auxiliary local jobs).
/// Overridden by config.maximus_model / MAXIMUS_MODEL env.
pub const COMPRESSOR_DEFAULT_MODEL: &str = "gemma2:2b";

// ---------------------------------------------------------------------------
// Curation / allowlists
// ---------------------------------------------------------------------------

/// Curated Ollama allowlist — the fast local Gemma 4 tags (e4b/12b) plus the
/// strong cloud tags, and `ornith:latest` for testing. E2B-class excluded
/// (poorly quantized). Hand-extend via config.agent.ollama_allow.
pub const OLLAMA_CURATED: &[&str] = &[
    "gemma4:e4b",
    "gemma4:12b",
    "gemma4:cloud",
    "gemma4:31b-cloud",
    // GLM 5.x — 5.3-flash released 2026-08-27 (open weights + Ollama cloud tag).
    "glm-5.3-flash",
    "glm-5.3-flash:cloud",
    "glm-5.2:cloud",
    "ornith:latest",
];

// ---------------------------------------------------------------------------
// Capability / behavior switches
// ---------------------------------------------------------------------------

/// Models served ONLY by OpenAI's /v1/responses endpoint (they 404 on
/// /v1/chat/completions): the codex, -pro, and deep-research variants. Base
/// chat models and the standard reasoning models (o1/o3/o4-mini) support
/// both, so they stay on chat/completions.
pub fn needs_responses_api(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.contains("codex") || m.contains("-pro") || m.contains("deep-research")
}

/// api.openai.com rejects `max_tokens` on reasoning/gpt-5.x chat models
/// ("use max_completion_tokens") but accepts max_completion_tokens on all
/// current chat models. OpenAI-COMPATIBLE servers (llama.cpp / Sailfish,
/// vLLM, Ollama) generally only know `max_tokens` — key off the endpoint.
pub fn uses_max_completion_tokens(endpoint: &str) -> bool {
    endpoint.contains("api.openai.com")
}

/// Heuristic: is this a small / local model that benefits most from a tight
/// tool menu, a slim system prompt, slimmed tool schemas, and temperature 0?
///
/// True for Ollama and Sailfish, any OpenAI-compatible endpoint that is NOT
/// api.openai.com (llama.cpp, vLLM, …), or a model name carrying a small-
/// parameter tag.
pub fn is_small_model(provider: &str, model: &str, endpoint: &str) -> bool {
    let p = provider.trim().to_lowercase();
    if p == "ollama" || p == "sailfish" {
        return true;
    }
    if p == "openai" && !endpoint.contains("api.openai.com") {
        return true;
    }
    let m = model.to_lowercase();
    const SMALL_TAGS: &[&str] = &["e4b", "e2b", "1b", "2b", "3b", "4b", "mini-local"];
    SMALL_TAGS.iter().any(|t| m.contains(t))
}

/// Assumed context window when config.agent.context_tokens is unset (0).
/// Small/local models get the known 8k llama.cpp default so the budget
/// guard engages; cloud models manage themselves (0 = no trim).
pub fn default_context_tokens(small: bool) -> usize {
    if small { 8192 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_api_routing() {
        assert!(needs_responses_api("gpt-5-codex"));
        assert!(needs_responses_api("o1-pro"));
        assert!(needs_responses_api("o4-mini-deep-research"));
        assert!(!needs_responses_api("gpt-4o"));
        assert!(!needs_responses_api("o4-mini"));
        assert!(!needs_responses_api("gpt-5"));
    }

    #[test]
    fn small_model_classification() {
        assert!(is_small_model("sailfish", "gemma4-e4b", "http://localhost:22343"));
        assert!(is_small_model("ollama", "anything", "http://localhost:11434"));
        assert!(is_small_model("openai", "whatever", "http://localhost:8080"));
        assert!(!is_small_model("openai", "gpt-4o", "https://api.openai.com"));
        assert!(!is_small_model("anthropic", "claude-sonnet-5", "https://api.anthropic.com"));
    }

    #[test]
    fn defaults_exist_for_all_providers() {
        for p in ["anthropic", "openai", "gemini", "ollama", "sailfish"] {
            assert!(!default_model(p).is_empty(), "no default for {p}");
        }
    }
}
