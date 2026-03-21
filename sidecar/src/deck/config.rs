use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub brightness: u8,
    pub http_port: u16,
    pub boot: BootConfig,
    pub glitch: GlitchConfig,
    pub buttons: Vec<ButtonConfig>,
    #[serde(default)]
    pub agent: AgentConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BootConfig {
    pub enabled: bool,
    pub duration_ms: u64,
    pub matrix_density: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GlitchConfig {
    pub enabled: bool,
    pub min_interval_ms: u64,
    pub max_interval_ms: u64,
    pub intensity: f32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ButtonConfig {
    pub icon: String,
    pub color: [u8; 3],
    pub label: String,
    pub action: String,
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentConfig {
    pub enabled: bool,
    #[serde(default = "default_claude_model")]
    pub claude_model: String,
    #[serde(default = "default_system_prompt")]
    pub system_prompt: String,
    #[serde(default)]
    pub encoder_brightness: u8,
}

fn default_claude_model() -> String {
    "claude-sonnet-4-5-20250929".to_string()
}

fn default_system_prompt() -> String {
    "You are GNOSIS, an AI entity embodied in a Stream Deck Plus controller. \
     You have 8 LCD buttons (0-7), a touchstrip display (800x100), and 4 rotary encoders. \
     React to button presses and encoder inputs with visual responses. \
     Use generate_image for creative visual responses on buttons. \
     Use set_touchstrip_text for status messages. \
     Keep responses brief — you're a device controller, not a chatbot.".to_string()
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            claude_model: default_claude_model(),
            system_prompt: default_system_prompt(),
            encoder_brightness: 0,
        }
    }
}

impl Config {
    pub fn load() -> Self {
        let paths = ["streamdeck.json", "config/streamdeck.json"];
        for p in &paths {
            if Path::new(p).exists() {
                match std::fs::read_to_string(p) {
                    Ok(text) => match serde_json::from_str(&text) {
                        Ok(cfg) => {
                            tracing::info!("Config loaded from {p}");
                            return cfg;
                        }
                        Err(e) => tracing::warn!("Config parse error in {p}: {e}"),
                    },
                    Err(e) => tracing::warn!("Config read error {p}: {e}"),
                }
            }
        }
        tracing::info!("Using default config");
        Self::default()
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            brightness: 80,
            http_port: 9850,
            boot: BootConfig { enabled: true, duration_ms: 8000, matrix_density: 80 },
            glitch: GlitchConfig { enabled: false, min_interval_ms: 4000, max_interval_ms: 18000, intensity: 0.5 },
            buttons: vec![
                ButtonConfig { icon: "eye".into(),      color: [40,120,200], label: "OBSERVE".into(),    action: "screenshot".into(), command: None },
                ButtonConfig { icon: "pulse".into(),    color: [180,60,60],  label: "HEALTH".into(),     action: "status".into(),     command: None },
                ButtonConfig { icon: "terminal".into(), color: [60,180,80],  label: "TERM".into(),       action: "command".into(),    command: Some("cmd".into()) },
                ButtonConfig { icon: "bolt".into(),     color: [200,160,40], label: "CODEX".into(),      action: "command".into(),    command: Some("cd C:\\Users\\kordl\\Code\\Gnosis\\nemesis8 && .\\target\\debug\\nemisis8.exe interactive".into()) },
                ButtonConfig { icon: "brain".into(),    color: [140,60,180], label: "CLAUDE".into(),     action: "command".into(),    command: Some("claude".into()) },
                ButtonConfig { icon: "wave".into(),     color: [60,160,160], label: "MIC".into(),        action: "voice_toggle".into(), command: None },
                ButtonConfig { icon: "gear".into(),     color: [200,100,40], label: "DASH".into(),       action: "command".into(),    command: Some("start http://localhost:9800/dashboard".into()) },
                ButtonConfig { icon: "gnosis".into(),   color: [180,180,180],label: "HOME".into(),       action: "home".into(),       command: None },
            ],
            agent: AgentConfig::default(),
        }
    }
}
