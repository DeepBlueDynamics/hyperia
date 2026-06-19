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
                "description": "Read the current Hyperia configuration from disk. Returns the JSON contents with ALL secrets (API keys, tokens, passwords) redacted as ***REDACTED*** for safety.",
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

        let json: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => return format!("Error parsing config: {}", e),
        };

        // Redact ALL secrets (provider API keys, tokens, passwords) — not just
        // agentToken — so a config read can never disclose credentials. (#93)
        let json = crate::mcp::redact_secrets(&json);

        serde_json::to_string_pretty(&json).unwrap_or_else(|e| format!("Error serializing: {}", e))
    }
}

fn config_path() -> Option<std::path::PathBuf> {
    crate::util::shared_config_path()
}
