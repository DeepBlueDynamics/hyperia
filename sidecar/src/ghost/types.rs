use serde::{Deserialize, Serialize};

/// What the SSE stream sends to the Ghost browser window.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum GhostEvent {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(rename = "tool_start")]
    ToolStart { name: String, id: String },
    #[serde(rename = "tool_result")]
    ToolResult { id: String, name: String, input: serde_json::Value, output: String },
    /// Fires for show_input / show_button / show_picker tools right before
    /// the dispatch blocks on user input. The renderer uses this to render
    /// the matching inline widget (passing `input` through). The agent's
    /// `tool_result` arrives later when the user submits via
    /// POST /api/ghost/ui-response.
    #[serde(rename = "show_widget")]
    ShowWidget { id: String, kind: String, input: serde_json::Value },
    /// Mounts a self-contained dynamic UI widget (HTML+CSS+JS in one srcdoc
    /// string) into the chat scrollback. Non-blocking — agent continues
    /// immediately. The widget fetches its data via
    /// GET /api/ghost/widget/:id/data?key=<exposed-key> and can queue
    /// actions back to the agent via POST /api/ghost/widget/:id/action.
    /// `exposes` allowlists the data keys the widget may fetch; `permits`
    /// allowlists the action names it may request.
    #[serde(rename = "tool_mount")]
    ToolMount {
        id: String,
        name: String,
        srcdoc: String,
        exposes: Vec<String>,
        permits: Vec<String>,
        height: u32,
    },
    #[serde(rename = "watercooler")]
    Watercooler { summary: String, tool_calls: usize },
    #[serde(rename = "retrying")]
    Retrying { attempt: u32, wait_secs: u64 },
    #[serde(rename = "done")]
    Done { stop_reason: String, turns: usize },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "stats")]
    Stats { input_tokens: u64, output_tokens: u64, tool_calls: usize, turns: usize },
    #[serde(rename = "thinking_start")]
    ThinkingStart { id: String },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { id: String, text: String },
    #[serde(rename = "thinking_end")]
    ThinkingEnd { id: String },
}

/// A tool definition in Anthropic API format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// A pending tool call accumulated from streaming deltas.
#[derive(Debug, Clone)]
pub struct PendingToolCall {
    pub id: String,
    pub name: String,
    pub json_fragments: String,
}

/// Normalized events from the streaming provider.
#[derive(Debug)]
pub enum ProviderEvent {
    TextDelta(String),
    ToolCallStart { id: String, name: String },
    ToolCallDelta { id: String, json_fragment: String },
    ToolCallEnd { id: String },
    Usage { input_tokens: u64, output_tokens: u64 },
    MessageStop { stop_reason: String },
    Retrying { attempt: u32, wait_secs: u64 },
    Error(String),
    ThinkingStart { id: String },
    ThinkingDelta { id: String, text: String },
    ThinkingEnd { id: String },
}

/// Ghost agent config, loaded from ~/.hyperia/hyperia.json.
///
/// Provider is explicit — no string-prefix detection. The renderer (or the
/// settings agent via model_catalog/show_picker) writes both
/// `config.agent.provider` and `config.agent.model` together so routing is
/// unambiguous. Tokens and endpoints come from
/// `config.providers.<provider>.{token, endpoint}` so users can keep multiple
/// providers configured side-by-side and switch agent.model without
/// re-pasting keys.
#[derive(Debug, Clone)]
pub struct GhostConfig {
    /// One of: "anthropic", "openai", "gemini", "ollama". Lower-case.
    pub provider: String,
    /// The full model id (e.g. "claude-sonnet-4-6", "gpt-4o", "llama3.2").
    /// Pass through verbatim to the underlying provider.
    pub model: String,
    /// API key for cloud providers. Empty string for ollama local.
    pub api_key: String,
    /// HTTP endpoint base. Falls back to a built-in default per provider:
    ///   anthropic → https://api.anthropic.com
    ///   openai    → https://api.openai.com
    ///   gemini    → https://generativelanguage.googleapis.com
    ///   ollama    → http://localhost:11434
    pub endpoint: String,
    pub max_turns: usize,
    /// Maximus model configuration (optional, overrides environment/defaults)
    pub maximus_model: Option<String>,
    /// Maximus Ollama URL configuration (optional, overrides environment/defaults)
    pub maximus_url: Option<String>,
    /// Whether Maximus is explicitly disabled
    pub maximus_disabled: bool,
}

/// Chat request from the browser.
#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub message: String,
}
