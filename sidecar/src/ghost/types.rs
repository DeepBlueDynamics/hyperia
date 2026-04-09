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
    ToolResult { id: String, output: String },
    #[serde(rename = "watercooler")]
    Watercooler { summary: String, tool_calls: usize },
    #[serde(rename = "retrying")]
    Retrying { attempt: u32, wait_secs: u64 },
    #[serde(rename = "done")]
    Done { stop_reason: String, turns: usize },
    #[serde(rename = "error")]
    Error { message: String },
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
}

/// Ghost agent config, loaded from ~/.hyperia/hyperia.json.
#[derive(Debug, Clone)]
pub struct GhostConfig {
    pub api_key: String,
    pub model: String,
    pub max_turns: usize,
}

/// Chat request from the browser.
#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub message: String,
}
