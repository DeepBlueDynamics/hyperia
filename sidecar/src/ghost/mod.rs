pub mod agent;
pub mod api;
pub mod asset;
pub mod bootstub;
pub mod compressor;
pub mod ferricula;
pub mod provider;
pub mod registry;
pub mod types;
pub mod widget;
pub mod gpu;

pub use api::GhostState;
pub use types::GhostConfig;

use std::path::PathBuf;

/// Built-in default endpoint per known provider. Users can override per
/// provider via `config.providers.<name>.endpoint`.
fn default_endpoint(provider: &str) -> String {
    match provider {
        "anthropic" => "https://api.anthropic.com".to_string(),
        "openai" => "https://api.openai.com".to_string(),
        "gemini" => "https://generativelanguage.googleapis.com".to_string(),
        "ollama" => {
            if std::path::Path::new("/.dockerenv").exists() {
                "http://host.docker.internal:11434".to_string()
            } else {
                "http://localhost:11434".to_string()
            }
        }
        _ => "".to_string(),
    }
}

/// Load Ghost config from the shared Hyperia config file.
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
/// Falls back to local Ollama with `gemma2:9b` if nothing else is usable.
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

    // Token: the Hyperia Agent config pane's key wins (config.agent.keys.<p>),
    // then the provider section, then stored env from chooser config, then
    // system env, then legacy agentToken.
    let mut api_key = cfg["agent"]["keys"][&provider].as_str().unwrap_or("").trim().to_string();
    if api_key.is_empty() {
        api_key = provider_section["token"].as_str().unwrap_or("").to_string();
    }
    if api_key.is_empty() {
        let env_keys = match provider.as_str() {
            "anthropic" => vec!["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"],
            "openai" => vec!["OPENAI_API_KEY", "OPENAI_TOKEN"],
            "gemini" => vec!["GEMINI_API_KEY", "GEMINI_TOKEN"],
            "grok" => vec!["XAI_API_KEY", "GROK_API_KEY"],
            _ => vec![],
        };
        for key in env_keys {
            if let Some(val) = cfg["env"][key].as_str() {
                if !val.trim().is_empty() {
                    api_key = val.trim().to_string();
                    break;
                }
            }
            if let Ok(val) = std::env::var(key) {
                if !val.trim().is_empty() {
                    api_key = val.trim().to_string();
                    break;
                }
            }
        }
    }
    if api_key.is_empty() {
        let legacy = cfg["agentToken"].as_str().unwrap_or("");
        let looks_anthropic = legacy.starts_with("sk-ant-");
        match provider.as_str() {
            "anthropic" if looks_anthropic => api_key = legacy.to_string(),
            "openai" if !legacy.is_empty() && !looks_anthropic => api_key = legacy.to_string(),
            _ => {}
        }
    }

    let mut endpoint = {
        let configured = provider_section["endpoint"].as_str().unwrap_or("").trim();
        if configured.is_empty() {
            default_endpoint(&provider)
        } else {
            configured.trim_end_matches('/').to_string()
        }
    };

    // Sailfish's default endpoint is derived from the shared config's service
    // port (config.agent.services.sailfish.port, default 22343) — default_endpoint
    // can't see the config, so resolve it here when no per-provider override is set.
    if provider == "sailfish" && endpoint.is_empty() {
        let port = cfg["agent"]["services"]["sailfish"]["port"]
            .as_u64()
            .unwrap_or(22343);
        endpoint = format!("http://localhost:{}", port);
    }

    if provider == "ollama" && std::path::Path::new("/.dockerenv").exists() {
        if endpoint == "http://localhost:11434" || endpoint == "http://127.0.0.1:11434" {
            endpoint = "http://host.docker.internal:11434".to_string();
        }
    }

    // Local providers (Ollama, Sailfish) don't require a token — they're
    // localhost-only appliances. Cloud providers do — without one we can't
    // honor the user's choice, so fall back to local Ollama and let the doctor
    // probe surface what's missing. Sailfish must NOT fall back to Ollama on an
    // empty key (it's a valid keyless local endpoint).
    if provider != "ollama" && provider != "sailfish" && api_key.is_empty() {
        tracing::warn!(
            "agent.provider = '{}' but no token configured at config.providers.{}.token — falling back to local Ollama. Use the settings agent to paste a key.",
            provider, provider
        );
        return Some(default_local_ollama());
    }

    if model.is_empty() {
        model = default_model(&provider).to_string();
    }

    let maximus_model = cfg["maximus"]["model"].as_str().map(|s| s.to_string());
    let maximus_url = cfg["maximus"]["url"].as_str().map(|s| s.to_string());
    let maximus_disabled = cfg["maximus"]["disabled"].as_bool().unwrap_or(false);

    // MCP-tool-doors: mode + context budget. `auto` (default) turns doors on
    // for every provider (small/local get the tight cap; cloud gets a larger
    // one). Env HYPERIA_TOOL_DOORS overrides. See doors::resolve_door_config.
    let tool_doors_mode = cfg["agent"]["tool_doors"].as_str().unwrap_or("auto");
    let doors = crate::doors::resolve_door_config(tool_doors_mode, &provider, &model, &endpoint);
    let context_tokens = cfg["agent"]["context_tokens"].as_u64().unwrap_or(0) as usize;

    Some(GhostConfig {
        provider,
        model,
        api_key,
        endpoint,
        max_turns: 25,
        doors,
        context_tokens,
        maximus_model,
        maximus_url,
        maximus_disabled,
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
        "ollama" => "gemma2:9b",
        // Sailfish: the integration guide's reference client uses "gemma4-e4b"
        // (gemma-4-E4B-it Q4_K_M). This is only a fallback — the served id can
        // swap (stock vs fine-tuned), so the authoritative source is GET
        // /v1/models, which the config pane probes live (ghost/api.rs
        // get_agent_models) and the user can pin via config.agent.model.
        "sailfish" => "gemma4-e4b",
        _ => "gemma2:9b",
    }
}

fn default_local_ollama() -> GhostConfig {
    let endpoint = default_endpoint("ollama");
    // Local Ollama is always a small/local model → auto-doors on with the tight
    // cap (env still overrides). Keep this consistent with load_config's path.
    let doors = crate::doors::resolve_door_config("auto", "ollama", "gemma2:9b", &endpoint);
    GhostConfig {
        provider: "ollama".into(),
        model: "gemma2:9b".into(),
        api_key: String::new(),
        endpoint,
        max_turns: 25,
        doors,
        context_tokens: 0,
        maximus_model: None,
        maximus_url: None,
        maximus_disabled: false,
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

pub(crate) fn config_path() -> Option<PathBuf> {
    crate::util::shared_config_path()
}
