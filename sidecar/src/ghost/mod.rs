pub mod agent;
pub mod api;
pub mod compressor;
pub mod ferricula;
pub mod provider;
pub mod registry;
pub mod types;

pub use api::GhostState;
pub use types::GhostConfig;

use std::path::PathBuf;

/// Built-in default endpoint per known provider. Users can override per
/// provider via `config.providers.<name>.endpoint`.
fn default_endpoint(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "https://api.anthropic.com",
        "openai" => "https://api.openai.com",
        "gemini" => "https://generativelanguage.googleapis.com",
        "ollama" => "http://localhost:11434",
        _ => "",
    }
}

/// Load Ghost config from ~/.hyperia/hyperia.json.
///
/// Schema (the source of truth, no string-prefix magic):
///   {
///     "config": {
///       "agent":     { "provider": "anthropic", "model": "claude-sonnet-4-6" },
///       "providers": {
///         "anthropic": { "token": "sk-ant-...", "endpoint": "..." },
///         "openai":    { "token": "sk-...",      "endpoint": "..." },
///         "gemini":    { "token": "...",          "endpoint": "..." },
///         "ollama":    { "endpoint": "http://localhost:11434", "token": "" }
///       }
///     }
///   }
///
/// Both endpoint and token are optional per provider. Ollama doesn't need a
/// token for the local default; if a user runs Ollama Cloud they can set
/// one and it'll be passed through.
///
/// Falls back to local Ollama with `llama3.2` if nothing else is usable.
pub fn load_config() -> Option<GhostConfig> {
    let cfg_path = config_path()?;
    let content = std::fs::read_to_string(&cfg_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let cfg = &json["config"];

    // -- Resolve agent.provider + agent.model with legacy migration ----

    // New shape first.
    let mut provider = cfg["agent"]["provider"]
        .as_str()
        .unwrap_or("")
        .to_lowercase();
    let mut model = cfg["agent"]["model"].as_str().unwrap_or("").to_string();

    // Legacy migration. If `agent.provider` isn't set, fall back to
    // `agentModel` (old single-field). Detect provider from the legacy
    // model name only as a one-time migration heuristic — never used at
    // runtime once the user has the new schema.
    if provider.is_empty() {
        let legacy_model = cfg["agentModel"].as_str().unwrap_or("").to_string();
        if !legacy_model.is_empty() {
            provider = legacy_provider_hint(&legacy_model);
            if model.is_empty() {
                model = legacy_model;
            }
        }
    }

    // Final fallback if still nothing.
    if provider.is_empty() {
        return Some(default_local_ollama());
    }

    // -- Resolve token + endpoint for that provider --------------------

    let providers = &cfg["providers"];
    let provider_section = &providers[&provider];

    // Token: provider-specific first, then legacy agentToken as fallback IF
    // the prefix matches (sk-ant- → anthropic, others → openai).
    let mut api_key = provider_section["token"].as_str().unwrap_or("").to_string();
    if api_key.is_empty() {
        let legacy = cfg["agentToken"].as_str().unwrap_or("");
        let looks_anthropic = legacy.starts_with("sk-ant-");
        match provider.as_str() {
            "anthropic" if looks_anthropic => api_key = legacy.to_string(),
            "openai" if !legacy.is_empty() && !looks_anthropic => api_key = legacy.to_string(),
            _ => {}
        }
    }

    let endpoint = {
        let configured = provider_section["endpoint"].as_str().unwrap_or("").trim();
        if configured.is_empty() {
            default_endpoint(&provider).to_string()
        } else {
            configured.trim_end_matches('/').to_string()
        }
    };

    // Ollama doesn't require a token. Cloud providers do — without one we
    // can't honor the user's choice, so fall back to local Ollama and let
    // the doctor probe surface what's missing.
    if provider != "ollama" && api_key.is_empty() {
        tracing::warn!(
            "agent.provider = '{}' but no token configured at config.providers.{}.token — falling back to local Ollama. Use the settings agent to paste a key.",
            provider, provider
        );
        return Some(default_local_ollama());
    }

    if model.is_empty() {
        model = default_model(&provider).to_string();
    }

    Some(GhostConfig {
        provider,
        model,
        api_key,
        endpoint,
        max_turns: 25,
    })
}

/// Pick a sensible default model when the user has set a provider but no
/// specific model yet. The settings agent will normally guide them to a
/// concrete one, but this keeps the chat reachable in the meantime.
fn default_model(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "claude-sonnet-4-6",
        "openai" => "gpt-4o",
        "gemini" => "gemini-2.0-flash",
        "ollama" => "llama3.2",
        _ => "llama3.2",
    }
}

fn default_local_ollama() -> GhostConfig {
    GhostConfig {
        provider: "ollama".into(),
        model: "llama3.2".into(),
        api_key: String::new(),
        endpoint: default_endpoint("ollama").into(),
        max_turns: 25,
    }
}

/// One-time migration helper — given a legacy agentModel string from an
/// older config, guess which provider the user meant. NEVER used at runtime
/// routing once the new schema is in place; only when migrating.
fn legacy_provider_hint(legacy_model: &str) -> String {
    let m = legacy_model.to_lowercase();
    if m.starts_with("ollama:") || m == "ollama" {
        return "ollama".into();
    }
    if m == "anthropic" || m.starts_with("claude-") || m.starts_with("claude_") {
        return "anthropic".into();
    }
    if m == "openai"
        || m.starts_with("gpt-")
        || m.starts_with("gpt_")
        || m.starts_with("o1")
        || m.starts_with("o3")
        || m.starts_with("o4")
    {
        return "openai".into();
    }
    if m == "gemini" || m.starts_with("gemini-") || m.starts_with("gemini_") {
        return "gemini".into();
    }
    // Unknown legacy model — best effort: anthropic if token looks anthropic
    // (caller decides), otherwise empty so we fall back to ollama.
    String::new()
}

fn config_path() -> Option<PathBuf> {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    }?;
    Some(PathBuf::from(home).join(".hyperia").join("hyperia.json"))
}
