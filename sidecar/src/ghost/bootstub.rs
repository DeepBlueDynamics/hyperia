//! Level-0 boot agent — pure Rust state machine, no LLM dependency.
//!
//! Runs when the shell's `/api/ghost/capabilities` reports `level: "none"`
//! (no frontier token AND no reachable Ollama). The user can still type in
//! the shell; bootstub recognizes a small set of bootstrap intents and
//! writes config to `~/.hyperia/hyperia.json`. Once a brain is wired,
//! capabilities flips to local/frontier/hybrid and bootstub steps aside.
//!
//! Recognized intents (all case-insensitive, substring match):
//!   * install ollama / get ollama / setup ollama  → print install command
//!   * paste anthropic token sk-ant-…              → extract + write config
//!   * paste openai token sk-…                     → extract + write config
//!   * paste gemini token AIza…                    → extract + write config
//!   * what's possible / help / what can you do    → list boot options
//!   * show config / what config                   → dump current config (redacted)
//!   * check / doctor / test / ping                → simple ack
//!   * anything else                               → "i don't know that yet" + menu

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct BootReply {
    /// Main agent-style reply shown as a `hyperia~>` row.
    pub text: String,
    /// Optional system-style lines shown before the reply.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub system: Vec<String>,
    /// True if config was changed — shell should re-probe `/capabilities`.
    pub config_changed: bool,
}

pub fn handle(message: &str) -> BootReply {
    let m = message.trim().to_lowercase();
    if m.is_empty() {
        return BootReply {
            text: "(empty input — say `what's possible` for the menu)".into(),
            system: vec![],
            config_changed: false,
        };
    }

    if matches_install_ollama(&m) {
        return reply_install_ollama();
    }
    if matches_help(&m) {
        return reply_what_is_possible();
    }
    if let Some(reply) = try_set_token(message) {
        return reply;
    }
    if matches_show_config(&m) {
        return reply_show_config();
    }
    if matches_check(&m) {
        return reply_check();
    }
    reply_unknown(message)
}

fn matches_install_ollama(m: &str) -> bool {
    m.contains("install ollama")
        || m.contains("ollama install")
        || m.contains("get ollama")
        || m.contains("setup ollama")
        || m.contains("set up ollama")
}

fn matches_help(m: &str) -> bool {
    m == "help"
        || m == "?"
        || m == "menu"
        || m.contains("what's possible")
        || m.contains("whats possible")
        || m.contains("what is possible")
        || m.contains("what can you do")
        || m.contains("what can i do")
        || m.contains("options")
}

fn matches_show_config(m: &str) -> bool {
    m == "config"
        || m == "show config"
        || m == "what config"
        || m.contains("show config")
        || m.contains("what's in config")
        || m.contains("dump config")
}

fn matches_check(m: &str) -> bool {
    m == "check" || m == "doctor" || m == "test" || m == "ping" || m.starts_with("check ")
}

/// Extract sk-ant- (anthropic), sk- (openai), or AIza (gemini, only when
/// "gemini" appears in the message) tokens. Returns BootReply with
/// config_changed=true on success.
fn try_set_token(raw: &str) -> Option<BootReply> {
    let words: Vec<&str> = raw.split_whitespace().collect();
    let lower = raw.to_lowercase();

    // Anthropic: sk-ant- prefix is unambiguous.
    for w in &words {
        let trimmed = w.trim_matches(|c: char| !c.is_ascii_graphic() || c == '"' || c == '\'');
        if trimmed.starts_with("sk-ant-") && trimmed.len() > 10 {
            return Some(write_token("anthropic", trimmed));
        }
    }
    // OpenAI: sk- prefix (not sk-ant-).
    for w in &words {
        let trimmed = w.trim_matches(|c: char| !c.is_ascii_graphic() || c == '"' || c == '\'');
        if trimmed.starts_with("sk-") && !trimmed.starts_with("sk-ant-") && trimmed.len() > 8 {
            return Some(write_token("openai", trimmed));
        }
    }
    // Gemini: AIza prefix, but only if "gemini" is mentioned (AIza keys
    // are used for other Google services too — don't guess).
    if lower.contains("gemini") {
        for w in &words {
            let trimmed = w.trim_matches(|c: char| !c.is_ascii_graphic() || c == '"' || c == '\'');
            if trimmed.starts_with("AIza") && trimmed.len() > 20 {
                return Some(write_token("gemini", trimmed));
            }
        }
    }
    None
}

fn write_token(provider: &str, token: &str) -> BootReply {
    let path = match config_path() {
        Some(p) => p,
        None => {
            return BootReply {
                text: "couldn't find your home directory — set $HOME or $USERPROFILE and try again.".into(),
                system: vec![],
                config_changed: false,
            };
        }
    };

    let mut json: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({ "config": {} }));

    // Ensure structure exists.
    if !json["config"].is_object() {
        json["config"] = serde_json::json!({});
    }
    if !json["config"]["providers"].is_object() {
        json["config"]["providers"] = serde_json::json!({});
    }
    if !json["config"]["providers"][provider].is_object() {
        json["config"]["providers"][provider] = serde_json::json!({});
    }
    if !json["config"]["agent"].is_object() {
        json["config"]["agent"] = serde_json::json!({});
    }

    json["config"]["providers"][provider]["token"] = serde_json::json!(token);

    // Set agent.provider + a default model only if not already set.
    if json["config"]["agent"]["provider"]
        .as_str()
        .unwrap_or("")
        .is_empty()
    {
        json["config"]["agent"]["provider"] = serde_json::json!(provider);
    }
    if json["config"]["agent"]["model"]
        .as_str()
        .unwrap_or("")
        .is_empty()
    {
        let default_model = default_model_for(provider);
        if !default_model.is_empty() {
            json["config"]["agent"]["model"] = serde_json::json!(default_model);
        }
    }

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let payload = serde_json::to_string_pretty(&json).unwrap_or_default();
    match fs::write(&path, payload) {
        Ok(_) => {
            let preview = redact_token(token);
            let agent_provider = json["config"]["agent"]["provider"]
                .as_str()
                .unwrap_or(provider);
            let agent_model = json["config"]["agent"]["model"]
                .as_str()
                .unwrap_or("");
            BootReply {
                text: format!(
                    "wrote {} token ({}) to ~/.hyperia/hyperia.json and set agent.provider={} model={}. say anything to start the real agent.",
                    provider, preview, agent_provider, agent_model
                ),
                system: vec![],
                config_changed: true,
            }
        }
        Err(e) => BootReply {
            text: format!("failed to write config: {}", e),
            system: vec![],
            config_changed: false,
        },
    }
}

fn default_model_for(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "claude-sonnet-4-6",
        "openai" => "gpt-4o",
        "gemini" => "gemini-2.0-flash",
        _ => "",
    }
}

fn redact_token(token: &str) -> String {
    if token.len() > 12 {
        format!("{}…{}", &token[..6], &token[token.len() - 3..])
    } else {
        "***".into()
    }
}

fn reply_install_ollama() -> BootReply {
    let cmd = if cfg!(windows) {
        "powershell -c \"iwr https://ollama.com/install.ps1 -useb | iex\""
    } else if cfg!(target_os = "macos") {
        "brew install ollama   # or grab from ollama.com"
    } else {
        "curl -fsSL https://ollama.com/install.sh | sh"
    };
    BootReply {
        text: format!(
            "ollama install for your platform:\n\n  {}\n\nafter install: `ollama pull llama3.2` (smallest useful chat model) or `ollama pull qwen2.5-coder:7b` (better at tool use). once `ollama serve` is up, refresh this page and i'll see it.",
            cmd
        ),
        system: vec![],
        config_changed: false,
    }
}

fn reply_what_is_possible() -> BootReply {
    BootReply {
        text: "i can boot you into one of:\n\n\
            * local — ollama on http://localhost:11434.\n  type `install ollama`.\n\n\
            * frontier — anthropic / openai / gemini.\n  paste a token (sk-ant-… / sk-… / AIza…) anywhere in your message.\n\n\
            * hybrid — both, with ollama doing compression and a frontier model doing chat. happens automatically when both are configured.\n\n\
            once a brain is wired, i hand off to the real agent and disappear. type `show config` to see the current state.".into(),
        system: vec![],
        config_changed: false,
    }
}

fn reply_check() -> BootReply {
    BootReply {
        text: "i'm here. for a real readiness probe (with provider + ferricula + tool checks) you need a model wired first — type `what's possible`.".into(),
        system: vec![],
        config_changed: false,
    }
}

fn reply_show_config() -> BootReply {
    let path = match config_path() {
        Some(p) => p,
        None => {
            return BootReply {
                text: "couldn't locate config path.".into(),
                system: vec![],
                config_changed: false,
            };
        }
    };
    let raw = fs::read_to_string(&path).unwrap_or_else(|_| "(no config file yet — nothing to show)".into());
    BootReply {
        text: format!(
            "config at `{}`:\n\n```\n{}\n```",
            path.display(),
            redact_config_tokens(&raw)
        ),
        system: vec![],
        config_changed: false,
    }
}

fn reply_unknown(raw: &str) -> BootReply {
    let preview = if raw.len() > 60 {
        format!("{}…", &raw[..57])
    } else {
        raw.to_string()
    };
    BootReply {
        text: format!(
            "i don't know what `{}` means yet. i only handle a small set of bootstrap intents:\n\n\
            * `install ollama` — local model install command for your platform\n\
            * `paste anthropic token sk-ant-…` (or paste it anywhere)\n\
            * `paste openai token sk-…`\n\
            * `paste gemini token AIza…`\n\
            * `what's possible` — boot options\n\
            * `show config` — current ~/.hyperia/hyperia.json (token redacted)\n\n\
            once a model is wired, you'll be talking to the real agent (which understands much more).",
            preview
        ),
        system: vec![],
        config_changed: false,
    }
}

/// Line-based redaction of `"token": "..."` values. Not a full JSON parser
/// (which would lose key order / comments), just a regex-free scan.
fn redact_config_tokens(s: &str) -> String {
    s.lines()
        .map(|line| {
            let Some(tok_idx) = line.find("\"token\"") else {
                return line.to_string();
            };
            let head = &line[..tok_idx];
            let rest = &line[tok_idx..];
            let Some(colon) = rest.find(':') else {
                return line.to_string();
            };
            let after_colon = &rest[colon + 1..];
            let Some(first_quote) = after_colon.find('"') else {
                return line.to_string();
            };
            let after_quote = &after_colon[first_quote + 1..];
            let Some(last_quote) = after_quote.find('"') else {
                return line.to_string();
            };
            let value = &after_quote[..last_quote];
            let preview = redact_token(value);
            let tail = &after_quote[last_quote..];
            format!("{}{}: \"{}{}", head, &rest[..colon + 1], preview, tail)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn config_path() -> Option<PathBuf> {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    }?;
    Some(PathBuf::from(home).join(".hyperia").join("hyperia.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_ollama_intent_detected() {
        let r = handle("install ollama please");
        assert!(r.text.contains("ollama"), "should mention ollama: {}", r.text);
        assert!(!r.config_changed);
    }

    #[test]
    fn install_ollama_synonyms() {
        for phrase in &["get ollama", "set up ollama", "setup ollama", "ollama install"] {
            assert!(matches_install_ollama(phrase), "should match: {}", phrase);
        }
    }

    #[test]
    fn whats_possible_lists_modes() {
        let r = handle("what's possible");
        assert!(r.text.contains("local") && r.text.contains("frontier") && r.text.contains("hybrid"));
        assert!(!r.config_changed);
    }

    #[test]
    fn help_synonyms() {
        for phrase in &["help", "?", "menu", "what can you do", "what is possible", "options"] {
            assert!(matches_help(phrase), "should match: {}", phrase);
        }
    }

    #[test]
    fn unknown_input_returns_menu_with_intents() {
        let r = handle("xyzzy");
        assert!(r.text.contains("install ollama"));
        assert!(r.text.contains("anthropic"));
        assert!(!r.config_changed);
    }

    #[test]
    fn empty_input() {
        let r = handle("   ");
        assert!(r.text.contains("empty"));
        assert!(!r.config_changed);
    }

    /// Dry version of try_set_token — returns just the provider name
    /// without writing to disk. Used by tests so they don't clobber the
    /// real ~/.hyperia/hyperia.json.
    fn try_set_token_dry(raw: &str) -> Option<String> {
        let words: Vec<&str> = raw.split_whitespace().collect();
        let lower = raw.to_lowercase();
        for w in &words {
            let t = w.trim_matches(|c: char| !c.is_ascii_graphic() || c == '"' || c == '\'');
            if t.starts_with("sk-ant-") && t.len() > 10 {
                return Some("anthropic".into());
            }
        }
        for w in &words {
            let t = w.trim_matches(|c: char| !c.is_ascii_graphic() || c == '"' || c == '\'');
            if t.starts_with("sk-") && !t.starts_with("sk-ant-") && t.len() > 8 {
                return Some("openai".into());
            }
        }
        if lower.contains("gemini") {
            for w in &words {
                let t = w.trim_matches(|c: char| !c.is_ascii_graphic() || c == '"' || c == '\'');
                if t.starts_with("AIza") && t.len() > 20 {
                    return Some("gemini".into());
                }
            }
        }
        None
    }

    #[test]
    fn token_extraction_recognizes_anthropic() {
        let r = try_set_token_dry("here's my key: sk-ant-api03-abcdef123456");
        assert_eq!(r.as_deref(), Some("anthropic"));
    }

    #[test]
    fn token_extraction_recognizes_openai() {
        let r = try_set_token_dry("paste openai token sk-proj-1234567890abcdef");
        assert_eq!(r.as_deref(), Some("openai"));
    }

    #[test]
    fn token_extraction_recognizes_gemini_when_mentioned() {
        let r = try_set_token_dry("gemini token AIzaSyAbcdef0123456789012345");
        assert_eq!(r.as_deref(), Some("gemini"));
    }

    #[test]
    fn token_extraction_skips_aiza_without_gemini_keyword() {
        // Same key, no "gemini" word → don't pattern-match (AIza is also
        // used for other Google services; require explicit mention).
        let r = try_set_token_dry("here is AIzaSyAbcdef0123456789012345");
        assert!(r.is_none());
    }

    #[test]
    fn token_extraction_rejects_too_short_sk() {
        let r = try_set_token_dry("sk-short");
        assert!(r.is_none());
    }

    #[test]
    fn redact_config_masks_tokens() {
        let cfg = "{\n  \"config\": {\n    \"providers\": {\n      \"anthropic\": { \"token\": \"sk-ant-api03-supersecret-abcdef\" }\n    }\n  }\n}";
        let r = redact_config_tokens(cfg);
        assert!(!r.contains("supersecret"));
        assert!(r.contains("sk-ant"));
        assert!(r.contains("…"));
    }

    #[test]
    fn redact_token_short_returns_stars() {
        assert_eq!(redact_token("short"), "***");
    }

    #[test]
    fn redact_token_long_shows_prefix_suffix() {
        let r = redact_token("sk-ant-api03-abcdefghij1234");
        assert!(r.starts_with("sk-ant"));
        assert!(r.ends_with("234"));
        assert!(r.contains("…"));
    }
}
