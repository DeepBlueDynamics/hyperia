pub mod agent;
pub mod api;
pub mod ferricula;
pub mod provider;
pub mod registry;
pub mod types;

pub use api::GhostState;
pub use types::GhostConfig;

use std::path::PathBuf;

/// Load Ghost config from ~/.hyperia/hyperia.json.
///
/// Priority:
///  1. Explicit `ollama:*` model in config → use Ollama (no API key required).
///  2. Cloud model with a valid API key → use that provider.
///  3. No config / no key → fall back to local Ollama with `ollama:gemma4:e2b`.
pub fn load_config() -> Option<GhostConfig> {
    let cfg_path = config_path()?;

    let content = std::fs::read_to_string(&cfg_path).ok();

    if let Some(content) = content {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            let config = &json["config"];
            let model = config["agentModel"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let api_key = config["agentToken"]
                .as_str()
                .unwrap_or("")
                .to_string();

            // Ollama models don't need an API key
            if model.starts_with("ollama:") {
                return Some(GhostConfig {
                    api_key: String::new(),
                    model,
                    max_turns: 25,
                });
            }

            // Cloud model with API key
            if !api_key.is_empty() {
                let model = if model.is_empty() {
                    "anthropic".to_string()
                } else {
                    model
                };
                return Some(GhostConfig {
                    api_key,
                    model,
                    max_turns: 25,
                });
            }
        }
    }

    // No valid config → default to local Ollama
    Some(GhostConfig {
        api_key: String::new(),
        model: "ollama:gemma4:e2b".to_string(),
        max_turns: 25,
    })
}

fn config_path() -> Option<PathBuf> {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    }?;
    Some(PathBuf::from(home).join(".hyperia").join("hyperia.json"))
}
