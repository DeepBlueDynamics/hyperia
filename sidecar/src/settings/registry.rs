use std::path::PathBuf;

use super::super::ghost::types::ToolDef;

pub struct SettingsRegistry;

impl SettingsRegistry {
    pub fn new() -> Self {
        Self
    }

    pub fn tool_defs(&self) -> Vec<ToolDef> {
        let defs: Vec<serde_json::Value> = serde_json::from_value(serde_json::json!([
            {
                "name": "read_config",
                "description": "Read the current Hyperia configuration from disk. Returns the JSON contents of ~/.hyperia/hyperia.json, with the agentToken redacted for safety.",
                "input_schema": {
                    "type": "object",
                    "properties": {}
                }
            }
        ]))
        .unwrap_or_default();

        defs.into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect()
    }

    pub async fn execute(&self, name: &str, input: &serde_json::Value) -> String {
        let _ = input;
        match name {
            "read_config" => self.read_config(),
            _ => format!("Unknown settings tool: {}", name),
        }
    }

    fn read_config(&self) -> String {
        let path = match config_path() {
            Some(p) => p,
            None => return "Error: could not resolve config path".into(),
        };

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => return format!("Error reading config: {}", e),
        };

        let mut json: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => return format!("Error parsing config: {}", e),
        };

        // Redact the API token
        if let Some(token) = json.pointer_mut("/config/agentToken") {
            if token.as_str().map(|s| !s.is_empty()).unwrap_or(false) {
                *token = serde_json::Value::String("[REDACTED]".into());
            }
        }

        serde_json::to_string_pretty(&json).unwrap_or_else(|e| format!("Error serializing: {}", e))
    }
}

fn config_path() -> Option<PathBuf> {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    }?;
    Some(PathBuf::from(home).join(".hyperia").join("hyperia.json"))
}
