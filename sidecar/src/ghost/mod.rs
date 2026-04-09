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
pub fn load_config() -> Option<GhostConfig> {
    let cfg_path = config_path()?;
    let content = std::fs::read_to_string(&cfg_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;

    let config = &json["config"];
    let api_key = config["agentToken"].as_str()?.to_string();
    let model = config["agentModel"]
        .as_str()
        .unwrap_or("anthropic")
        .to_string();

    if api_key.is_empty() {
        return None;
    }

    Some(GhostConfig {
        api_key,
        model,
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
