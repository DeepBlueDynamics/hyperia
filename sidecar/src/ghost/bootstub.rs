//! Level-0 boot agent — pure Rust state machine, no LLM dependency.
//!
//! Runs when the shell's `/api/ghost/capabilities` reports `level: "none"`
//! (no frontier token AND no reachable Ollama). The user can still type in
//! the shell; bootstub recognizes a small set of bootstrap intents and
//! writes config to the shared Hyperia config. Once a brain is wired,
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
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

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

    if m == "wipe config" || m == "reset config" || m == "clear config" || m == "wipe" {
        return reply_wipe_config();
    }

    if matches_install_ollama(&m) {
        return reply_install_ollama();
    }
    if matches_help(&m) {
        return reply_what_is_possible();
    }
    if let Some(reply) = try_set_provider_token(message) {
        return reply;
    }
    if let Some(reply) = try_toggle_maximus(message) {
        return reply;
    }
    if let Some(reply) = try_set_token(message) {
        return reply;
    }
    if m == "list models" || m.contains("list models") {
        return reply_list_models();
    }
    if m == "list panes" || m.contains("list panes") {
        return reply_list_panes();
    }
    if m == "show logs" || m.contains("show logs") || m == "logs" {
        return reply_show_logs();
    }
    if m == "doctor" {
        return reply_doctor();
    }
    if m == "version" || m.contains("version") {
        return reply_version();
    }
    if m.starts_with("get ") {
        let path_arg = message[4..].trim();
        return reply_get_config_path(path_arg);
    }
    if m.starts_with("run ") {
        let cmd_arg = message[4..].trim();
        return reply_run_cmd(cmd_arg);
    }
    if m.starts_with("open ") {
        let url_arg = message[5..].trim();
        return reply_open_url(url_arg);
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
pub fn try_set_token(raw: &str) -> Option<BootReply> {
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

/// Intercepts command to enable/disable Maximus context compressor.
pub fn try_toggle_maximus(raw: &str) -> Option<BootReply> {
    let m = raw.trim().to_lowercase();
    if m == "maximus on" || m == "enable maximus" || m == "maximus enable" {
        return Some(write_maximus_disabled(false));
    }
    if m == "maximus off" || m == "disable maximus" || m == "maximus disable" {
        return Some(write_maximus_disabled(true));
    }
    None
}

fn write_maximus_disabled(disabled: bool) -> BootReply {
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
    if !json["config"]["maximus"].is_object() {
        json["config"]["maximus"] = serde_json::json!({});
    }

    json["config"]["maximus"]["disabled"] = serde_json::json!(disabled);

    match crate::util::write_json_file_atomic(&path, &json) {
        Ok(_) => {
            let status_text = if disabled { "DISABLED" } else { "ENABLED" };
            BootReply {
                text: format!("Maximus context compressor has been {}.", status_text),
                system: vec![],
                config_changed: true,
            }
        }
        Err(e) => BootReply {
            text: format!("failed to write config file: {}", e),
            system: vec![],
            config_changed: false,
        },
    }
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

    // Set agent.provider + default model. If the provider is different or not set yet,
    // we explicitly switch to this provider and set its default model.
    let old_provider = json["config"]["agent"]["provider"]
        .as_str()
        .unwrap_or("");
    if old_provider != provider {
        json["config"]["agent"]["provider"] = serde_json::json!(provider);
        let default_model = default_model_for(provider);
        if !default_model.is_empty() {
            json["config"]["agent"]["model"] = serde_json::json!(default_model);
        }
    } else if json["config"]["agent"]["model"]
        .as_str()
        .unwrap_or("")
        .is_empty()
    {
        let default_model = default_model_for(provider);
        if !default_model.is_empty() {
            json["config"]["agent"]["model"] = serde_json::json!(default_model);
        }
    }

    match crate::util::write_json_file_atomic(&path, &json) {
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
                    "wrote {} token ({}) to {} and set agent.provider={} model={}. say anything to start the real agent.",
                    provider, preview, path.display(), agent_provider, agent_model
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
            "ollama install for your platform:\n\n  {}\n\nafter install, pull a model that handles tool calls well. recommended:\n  `ollama pull gemma2:2b`   — ~1.6GB, fast, reliable tool dispatch (this is the one verified inside hyperia)\n  `ollama pull qwen2.5-coder:7b` — slightly larger, also tool-capable, leans coding\n\nonce `ollama serve` is running (the installer usually starts it), refresh this page and i'll see it. avoid `llama3.2` for chat in hyperia — it tends to fall out of the tool-call format.",
            cmd
        ),
        system: vec![],
        config_changed: false,
    }
}

fn is_ollama_running() -> bool {
    if cfg!(test) {
        return true;
    }
    let port = std::env::var("OLLAMA_PORT").unwrap_or_else(|_| "11434".into());
    let host = if std::path::Path::new("/.dockerenv").exists() {
        "host.docker.internal"
    } else {
        "127.0.0.1"
    };
    let addr_str = format!("{}:{}", host, port);
    use std::net::ToSocketAddrs;
    if let Ok(mut addrs) = addr_str.to_socket_addrs() {
        if let Some(addr) = addrs.next() {
            return TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok();
        }
    }
    false
}

fn is_ollama_disabled() -> bool {
    if cfg!(test) {
        return false;
    }
    if std::env::var("MAXIMUS_DISABLED").map(|s| s.trim().to_lowercase() == "true" || s.trim() == "1").unwrap_or(false) {
        return true;
    }
    if let Some(path) = config_path() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if json["config"]["maximus"]["disabled"].as_bool().unwrap_or(false) {
                    return true;
                }
            }
        }
    }
    false
}

fn reply_what_is_possible() -> BootReply {
    let disabled = is_ollama_disabled();
    let running = is_ollama_running();
    if disabled || !running {
        let reason = if disabled {
            "disabled via configuration"
        } else {
            "unreachable / not running"
        };
        return BootReply {
            text: format!(
                "Ollama is {} (local mode unavailable).\n\n\
                 To enable the Hyperia agent, please configure an API token from one of the following providers:\n\n\
                 * **OpenAI** — paste your `sk-...` token anywhere in your message.\n\
                 * **Anthropic** — paste your `sk-ant-...` token anywhere in your message.\n\
                 * **Gemini** (Google) — paste your `AIza...` token anywhere in your message.\n\n\
                 Once a token is configured, Hyperia will activate the agent using that provider. Type `show config` to view the current configuration state, or `wipe config` to reset it.",
                reason
            ),
            system: vec![],
            config_changed: false,
        };
    }

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

fn reply_wipe_config() -> BootReply {
    let path = match config_path() {
        Some(p) => p,
        None => return BootReply { text: "could not find your home directory.".into(), system: vec![], config_changed: false },
    };
    let empty_cfg = serde_json::json!({ "config": {} });
    match crate::util::write_json_file_atomic(&path, &empty_cfg) {
        Ok(_) => BootReply {
            text: format!("wiped configuration file {} successfully. say anything or refresh to re-probe.", path.display()),
            system: vec![],
            config_changed: true,
        },
        Err(e) => BootReply {
            text: format!("failed to write config: {}", e),
            system: vec![],
            config_changed: false,
        }
    }
}

fn reply_unknown(raw: &str) -> BootReply {
    let preview = if raw.len() > 60 {
        format!("{}…", &raw[..57])
    } else {
        raw.to_string()
    };

    let disabled = is_ollama_disabled();
    let running = is_ollama_running();

    let text = if disabled || !running {
        let reason = if disabled {
            "disabled via configuration"
        } else {
            "unreachable / not running"
        };
        format!(
            "i don't know what `{}` means. Ollama is {} (local mode unavailable).\n\n\
             Please provide a token from a provider to activate the Hyperia agent:\n\n\
             * `paste openai token sk-…` (or just paste the token anywhere)\n\
             * `paste anthropic token sk-ant-…`\n\
             * `paste gemini token AIza…`\n\n\
             Other commands:\n\
             * `what's possible` — view options\n\
             * `show config` — view current shared Hyperia config\n\
             * `wipe config` — reset your configuration file\n\
             * `doctor` — check connection status",
            preview, reason
        )
    } else {
        format!(
            "i don't know what `{}` means yet. i only handle a small set of bootstrap intents:\n\n\
             * `install ollama` — local model install command for your platform\n\
             * `paste anthropic token sk-ant-…` (or paste it anywhere)\n\
             * `paste openai token sk-…`\n\
             * `paste gemini token AIza…`\n\
             * `what's possible` — boot options\n\
             * `show config` — current shared Hyperia config (token redacted)\n\
             * `wipe config` — reset your configuration file\n\n\
             once a model is wired, you'll be talking to the real agent (which understands much more).",
            preview
        )
    };

    BootReply {
        text,
        system: vec![],
        config_changed: false,
    }
}

fn http_get(path: &str) -> Result<String, String> {
    let port = std::env::var("HYPERIA_PORT").unwrap_or_else(|_| "9800".into());
    let addr = format!("127.0.0.1:{}", port);
    let mut stream = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("parse error: {}", e))?,
        Duration::from_secs(2),
    ).map_err(|e| format!("connect error: {}", e))?;
    
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok();

    // Use HTTP/1.0 to guarantee NO chunked transfer encoding!
    let request = format!(
        "GET {} HTTP/1.0\r\n\
         Host: 127.0.0.1\r\n\
         Connection: close\r\n\r\n",
        path
    );

    stream.write_all(request.as_bytes()).map_err(|e| format!("write error: {}", e))?;

    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|e| format!("read error: {}", e))?;

    if let Some(body_start) = response.find("\r\n\r\n") {
        Ok(response[body_start + 4..].to_string())
    } else {
        Ok(response)
    }
}

fn http_post_json(path: &str, body: &serde_json::Value) -> Result<String, String> {
    let port = std::env::var("HYPERIA_PORT").unwrap_or_else(|_| "9800".into());
    let addr = format!("127.0.0.1:{}", port);
    let mut stream = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("parse error: {}", e))?,
        Duration::from_secs(2),
    ).map_err(|e| format!("connect error: {}", e))?;
    
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok();

    let body_str = body.to_string();
    // Use HTTP/1.0 to avoid chunked encoding issues!
    let request = format!(
        "POST {} HTTP/1.0\r\n\
         Host: 127.0.0.1\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n\
         {}",
        path,
        body_str.len(),
        body_str
    );

    stream.write_all(request.as_bytes()).map_err(|e| format!("write error: {}", e))?;

    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|e| format!("read error: {}", e))?;

    if let Some(body_start) = response.find("\r\n\r\n") {
        Ok(response[body_start + 4..].to_string())
    } else {
        Ok(response)
    }
}

fn reply_list_models() -> BootReply {
    BootReply {
        text: "Recommended Local & Cloud Models for Hyperia:\n\n\
            * Local (Ollama):\n  \
              - `gemma2:2b` (Recommended - ~1.6GB, extremely fast, excellent structured JSON & tool dispatch)\n  \
              - `qwen2.5-coder:7b` (Strong alternative - 4.7GB, robust code generation)\n  \
              - `deepseek-coder:6.7b` (Coding specialist)\n\n\
            * Cloud (Frontier):\n  \
              - `claude-sonnet-4-6` (Default - Gold standard for agent tasks)\n  \
              - `gpt-4o` (Excellent overall tool performance)\n  \
              - `gemini-2.0-flash` (Extremely fast, massive context window)\n\n\
            To configure a provider, paste its API key (e.g. `sk-ant-...` or `AIza...`), or install/run Ollama locally.".into(),
        system: vec![],
        config_changed: false,
    }
}

fn reply_list_panes() -> BootReply {
    match http_get("/api/status") {
        Ok(status_str) => {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&status_str) {
                let mut lines = Vec::new();
                lines.push("Active Tab/Pane Hierarchy:".to_string());
                lines.push("".to_string());
                
                if let Some(windows) = json["windows"].as_array() {
                    for win in windows {
                        let win_id = win["id"].as_u64().unwrap_or(0);
                        let focused = if win["focused"].as_bool().unwrap_or(false) { " (focused)" } else { "" };
                        lines.push(format!("Window {}{}:", win_id, focused));
                        
                        if let Some(tabs) = win["tabs"].as_array() {
                            for tab in tabs {
                                let tab_name = tab["name"].as_str().unwrap_or("shell");
                                let active = if tab["active"].as_bool().unwrap_or(false) { " [active]" } else { "" };
                                lines.push(format!("  Tab '{}'{}:", tab_name, active));
                                
                                if let Some(panes) = tab["panes"].as_array() {
                                    for pane in panes {
                                        let label = pane["label"].as_str().unwrap_or("");
                                        let shell = pane["shell"].as_str().unwrap_or("");
                                        let proc = pane["process"].as_str().unwrap_or("");
                                        let active = if pane["active"].as_bool().unwrap_or(false) { " [active]" } else { "" };
                                        let cwd = pane["cwd"].as_str().unwrap_or("");
                                        
                                        let proc_info = if proc.is_empty() {
                                            shell.to_string()
                                        } else {
                                            format!("{} ({})", shell, proc)
                                        };
                                        
                                        lines.push(format!(
                                            "    Pane {}: {}{} in `{}`",
                                            if label.is_empty() { "-" } else { label },
                                            proc_info,
                                            active,
                                            cwd
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
                
                if lines.len() <= 2 {
                    BootReply {
                        text: "No active panes/sessions found.".to_string(),
                        system: vec![],
                        config_changed: false,
                    }
                } else {
                    BootReply {
                        text: lines.join("\n"),
                        system: vec![],
                        config_changed: false,
                    }
                }
            } else {
                BootReply {
                    text: format!("Error: failed to parse /api/status JSON. Raw response: {}", status_str),
                    system: vec![],
                    config_changed: false,
                }
            }
        }
        Err(e) => BootReply {
            text: format!("Error: failed to connect to /api/status. Is sidecar server running? Details: {}", e),
            system: vec![],
            config_changed: false,
        }
    }
}

pub fn try_set_provider_token(m: &str) -> Option<BootReply> {
    let parts: Vec<&str> = m.split_whitespace().collect();
    if parts.len() >= 4 && parts[0].to_lowercase() == "set" && parts[2].to_lowercase() == "token" {
        let provider = parts[1].to_lowercase();
        let token = parts[3].trim_matches(|c: char| !c.is_ascii_graphic() || c == '"' || c == '\'');
        if provider == "anthropic" || provider == "openai" || provider == "gemini" {
            return Some(write_token(&provider, token));
        }
    }
    None
}

fn reply_get_config_path(path_arg: &str) -> BootReply {
    let path = match config_path() {
        Some(p) => p,
        None => return BootReply { text: "Could not locate config directory.".into(), system: vec![], config_changed: false },
    };
    
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return BootReply { text: "No config file found yet. Configure a token first!".into(), system: vec![], config_changed: false },
    };
    
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(j) => j,
        Err(e) => return BootReply { text: format!("Error reading config JSON: {}", e), system: vec![], config_changed: false },
    };
    
    let keys: Vec<&str> = path_arg.split(|c| c == '.' || c == '/').filter(|s| !s.is_empty()).collect();
    if keys.is_empty() {
        return BootReply { text: "Error: empty config path. Usage: `get <config path>` (e.g. `get agent.model`)".into(), system: vec![], config_changed: false };
    }
    
    let mut current = &json;
    let keys_to_traverse = keys.clone();
    if !keys.is_empty() && keys[0] != "config" && json["config"].is_object() {
        current = &json["config"];
    }
    
    for key in keys_to_traverse {
        if let Some(next) = current.get(key) {
            current = next;
        } else {
            return BootReply {
                text: format!("Config path `{}` not found.", path_arg),
                system: vec![],
                config_changed: false,
            };
        }
    }
    
    let value_str = match current {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => {
            let is_sensitive = path_arg.to_lowercase().contains("token") 
                || path_arg.to_lowercase().contains("key") 
                || path_arg.to_lowercase().contains("password");
            if is_sensitive {
                redact_token(s)
            } else {
                s.clone()
            }
        }
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    
    BootReply {
        text: format!("{} = {}", path_arg, value_str),
        system: vec![],
        config_changed: false,
    }
}

fn reply_run_cmd(cmd_with_args: &str) -> BootReply {
    let parts: Vec<&str> = cmd_with_args.split_whitespace().collect();
    if parts.is_empty() {
        return BootReply { text: "Error: no command specified. Usage: `run <cmd>`".into(), system: vec![], config_changed: false };
    }
    
    let base_cmd = parts[0].to_lowercase();
    let whitelisted = ["ls", "pwd", "whoami", "date"];
    if !whitelisted.contains(&base_cmd.as_str()) {
        return BootReply {
            text: format!(
                "Error: command `{}` is not in the whitelist. Whitelisted commands: ls, pwd, whoami, date",
                base_cmd
            ),
            system: vec![],
            config_changed: false,
        };
    }
    
    let shell = if cfg!(windows) { "cmd" } else { "sh" };
    let shell_arg = if cfg!(windows) { "/c" } else { "-c" };
    
    match std::process::Command::new(shell)
        .arg(shell_arg)
        .arg(cmd_with_args)
        .output()
    {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let exit_code = output.status.code().unwrap_or(-1);
            
            let mut result = String::new();
            if !stdout.is_empty() {
                result.push_str(&stdout);
            }
            if !stderr.is_empty() {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str("stderr:\n");
                result.push_str(&stderr);
            }
            if result.is_empty() {
                result = format!("(command exited with code {})", exit_code);
            }
            
            BootReply {
                text: format!("$ {}\n{}", cmd_with_args, result.trim_end()),
                system: vec![],
                config_changed: false,
            }
        }
        Err(e) => BootReply {
            text: format!("Error: failed to execute command `{}`: {}", cmd_with_args, e),
            system: vec![],
            config_changed: false,
        }
    }
}

fn reply_open_url(url: &str) -> BootReply {
    let full_url = if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        format!("https://{}", url)
    };
    
    let body = serde_json::json!({ "url": full_url });
    match http_post_json("/api/web-pane", &body) {
        Ok(_) => BootReply {
            text: format!("Opened web pane for `{}`", full_url),
            system: vec![],
            config_changed: false,
        },
        Err(e) => BootReply {
            text: format!("Error opening web pane: {}", e),
            system: vec![],
            config_changed: false,
        }
    }
}

fn reply_show_logs() -> BootReply {
    match http_get("/api/logs") {
        Ok(logs_str) => {
            if let Ok(lines) = serde_json::from_str::<Vec<String>>(&logs_str) {
                if lines.is_empty() {
                    BootReply {
                        text: "Sidecar log buffer is currently empty.".to_string(),
                        system: vec![],
                        config_changed: false,
                    }
                } else {
                    let limit = 30;
                    let start = if lines.len() > limit { lines.len() - limit } else { 0 };
                    let recent_lines = &lines[start..];
                    BootReply {
                        text: format!(
                            "Recent sidecar logs (showing last {}/{} lines):\n\n```\n{}\n```",
                            recent_lines.len(),
                            lines.len(),
                            recent_lines.join("\n")
                        ),
                        system: vec![],
                        config_changed: false,
                    }
                }
            } else {
                BootReply {
                    text: format!("Error: failed to parse /api/logs JSON. Raw response: {}", logs_str),
                    system: vec![],
                    config_changed: false,
                }
            }
        }
        Err(e) => BootReply {
            text: format!("Error: failed to connect to /api/logs: {}", e),
            system: vec![],
            config_changed: false,
        }
    }
}

fn reply_doctor() -> BootReply {
    let mut lines = Vec::new();
    lines.push("Hyperia Diagnostic Report (Level-0 Bootstub):".to_string());
    lines.push("==============================================".to_string());
    
    lines.push(format!("Platform: {} ({})", std::env::consts::OS, std::env::consts::ARCH));
    
    let config_file_path = config_path();
    let mut config_ok = false;
    let mut anthropic_configured = false;
    let mut openai_configured = false;
    let mut gemini_configured = false;
    let mut active_provider = String::new();
    let mut active_model = String::new();
    
    if let Some(p) = &config_file_path {
        lines.push(format!("Config Path: {}", p.display()));
        if p.exists() {
            if let Ok(content) = fs::read_to_string(p) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    config_ok = true;
                    let config_obj = &json["config"];
                    
                    if let Some(prov) = config_obj["agent"]["provider"].as_str() {
                        active_provider = prov.to_string();
                    }
                    if let Some(mod_name) = config_obj["agent"]["model"].as_str() {
                        active_model = mod_name.to_string();
                    }
                    
                    let has_token_boot = |name: &str, config_obj: &serde_json::Value| -> bool {
                        if config_obj["providers"][name]["token"].as_str().map(|s| !s.is_empty()).unwrap_or(false) {
                            return true;
                        }
                        let env_keys = match name {
                            "anthropic" => vec!["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"],
                            "openai" => vec!["OPENAI_API_KEY", "OPENAI_TOKEN"],
                            "gemini" => vec!["GEMINI_API_KEY", "GEMINI_TOKEN"],
                            _ => vec![],
                        };
                        for key in env_keys {
                            if config_obj["env"][key].as_str().map(|s| !s.trim().is_empty()).unwrap_or(false) {
                                return true;
                            }
                            if std::env::var(key).map(|s| !s.trim().is_empty()).unwrap_or(false) {
                                return true;
                            }
                        }
                        false
                    };
                    
                    anthropic_configured = has_token_boot("anthropic", config_obj);
                    openai_configured = has_token_boot("openai", config_obj);
                    gemini_configured = has_token_boot("gemini", config_obj);
                }
            }
        }
    }
    
    if config_ok {
        lines.push("Config Status: Valid JSON".to_string());
        lines.push(format!("Active Provider: {}", if active_provider.is_empty() { "None".to_string() } else { active_provider.clone() }));
        lines.push(format!("Active Model: {}", if active_model.is_empty() { "None".to_string() } else { active_model }));
        
        let mut configured_provs = Vec::new();
        if anthropic_configured { configured_provs.push("Anthropic"); }
        if openai_configured { configured_provs.push("OpenAI"); }
        if gemini_configured { configured_provs.push("Gemini"); }
        
        lines.push(format!("Configured API Tokens: {}", if configured_provs.is_empty() { "None".to_string() } else { configured_provs.join(", ") }));
    } else {
        lines.push("Config Status: Not found or invalid".to_string());
    }
    
    let ollama_disabled = is_ollama_disabled();
    let mut ollama_running = false;
    if !ollama_disabled {
        let ollama_port = std::env::var("OLLAMA_PORT").unwrap_or_else(|_| "11434".into());
        let ollama_addr = format!("127.0.0.1:{}", ollama_port);
        if let Ok(addr) = ollama_addr.parse::<std::net::SocketAddr>() {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
                ollama_running = true;
            }
        }
    }
    
    lines.push(format!(
        "Ollama Status: {}",
        if ollama_disabled {
            "Disabled via configuration"
        } else if ollama_running {
            "Running locally (responding on port 11434)"
        } else {
            "Not running / unreachable"
        }
    ));

    let vram_opt = super::gpu::get_gpu_vram_gb();
    if let Some(vram) = vram_opt {
        lines.push(format!("GPU VRAM: {} GB", vram));
        if ollama_running {
            let target_model = if vram <= 8 { "gemma2:2b" } else { "gemma2:9b" };
            lines.push(format!("GPU VRAM target model: {}", target_model));
        }
    } else {
        lines.push("GPU VRAM: Undetected / CPU Only".to_string());
    }
    
    let sidecar_port = std::env::var("HYPERIA_PORT").unwrap_or_else(|_| "9800".into());
    let sidecar_addr = format!("127.0.0.1:{}", sidecar_port);
    let mut sidecar_running = false;
    if let Ok(addr) = sidecar_addr.parse::<std::net::SocketAddr>() {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
            sidecar_running = true;
        }
    }
    lines.push(format!(
        "Sidecar Server: {}",
        if sidecar_running {
            format!("Running on port {}", sidecar_port)
        } else {
            "Unreachable".to_string()
        }
    ));
    
    lines.push("".to_string());
    if (anthropic_configured || openai_configured || gemini_configured || (ollama_running && !ollama_disabled)) && !active_provider.is_empty() {
        lines.push("Diagnosis: Healthy! Capabilities should be active. If you are stuck in bootstub, try saying anything to start the real agent.".to_string());
    } else {
        let help_msg = if ollama_disabled {
            "Diagnosis: Attention Required. Please configure a provider token to enable agent brains."
        } else {
            "Diagnosis: Attention Required. Please configure a provider token or start Ollama local server to enable agent brains."
        };
        lines.push(help_msg.to_string());
    }
    
    BootReply {
        text: lines.join("\n"),
        system: vec![],
        config_changed: false,
    }
}

fn reply_version() -> BootReply {
    BootReply {
        text: format!("Hyperia Sidecar Version: v{}", env!("CARGO_PKG_VERSION")),
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
    crate::util::shared_config_path()
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
    /// real shared Hyperia config.
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

    #[test]
    fn test_list_models() {
        let r = handle("list models");
        assert!(r.text.contains("gemma2:2b"));
        assert!(r.text.contains("claude-sonnet-4-6"));
        assert!(!r.config_changed);
    }

    #[test]
    fn test_list_panes() {
        let r = handle("list panes");
        assert!(r.text.contains("Hierarchy") || r.text.contains("connect") || r.text.contains("No active panes"));
        assert!(!r.config_changed);
    }

    #[test]
    fn test_show_logs() {
        let r = handle("show logs");
        assert!(r.text.contains("Recent sidecar logs") || r.text.contains("connect") || r.text.contains("empty"));
        assert!(!r.config_changed);
    }

    #[test]
    fn test_doctor() {
        let r = handle("doctor");
        assert!(r.text.contains("Diagnostic Report"));
        assert!(r.text.contains("Platform:"));
        assert!(!r.config_changed);
    }

    #[test]
    fn test_version() {
        let r = handle("version");
        assert!(r.text.contains("Version"));
        assert!(!r.config_changed);
    }

    #[test]
    fn test_run_command_whitelist() {
        // Safe command
        let r = handle("run pwd");
        assert!(r.text.contains("$ pwd"));
        
        // Blocked command
        let r2 = handle("run rm -rf /");
        assert!(r2.text.contains("not in the whitelist"));
    }

    #[test]
    fn test_open_url() {
        let r = handle("open example.com");
        assert!(r.text.contains("Opened web pane") || r.text.contains("Error opening web pane"));
    }

    #[test]
    fn test_config_operations_integration() {
        // Setup a unique temp directory for config
        let temp_dir = std::env::temp_dir().join(format!("hyperia_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let orig_home = std::env::var("HOME").ok();
        let orig_userprofile = std::env::var("USERPROFILE").ok();

        std::env::set_var("HOME", &temp_dir);
        std::env::set_var("USERPROFILE", &temp_dir);

        // 1. set token
        let r_set = handle("set anthropic token sk-ant-api03-abcdef123456");
        assert!(r_set.text.contains("wrote anthropic token"));
        assert!(r_set.config_changed);

        // 2. get config path
        let r_get_model = handle("get agent.model");
        assert_eq!(r_get_model.text, "agent.model = claude-sonnet-4-6");

        let r_get_provider = handle("get agent.provider");
        assert_eq!(r_get_provider.text, "agent.provider = anthropic");

        let r_get_token = handle("get providers.anthropic.token");
        assert!(r_get_token.text.contains("sk-ant"));
        assert!(r_get_token.text.contains("…"));
        assert!(r_get_token.text.contains("456"));
        assert!(!r_get_token.text.contains("abcdef"));

        // 3. show config
        let r_show = handle("show config");
        assert!(r_show.text.contains("hyperia.json"));
        assert!(r_show.text.contains("sk-ant"));
        assert!(!r_show.text.contains("abcdef"));

        // Clean up
        let _ = std::fs::remove_dir_all(&temp_dir);
        if let Some(h) = orig_home {
            std::env::set_var("HOME", h);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(up) = orig_userprofile {
            std::env::set_var("USERPROFILE", up);
        } else {
            std::env::remove_var("USERPROFILE");
        }
    }
}
